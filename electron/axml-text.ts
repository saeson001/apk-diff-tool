/**
 * axml-text.ts — 通用 Android binary XML (AXML) 转可读文本
 *
 * 与 binaryXmlParser.ts（面向 Manifest 结构化提取）不同，本模块按文档顺序
 * 遍历 start/end/text/namespace 全部 chunk，重建缩进良好的 XML 文本，
 * 用于 hash 模式下对 AndroidManifest.xml 与 res/*.xml 做按需内容 diff。
 *
 * 输出保证稳定（同输入同输出），命名空间声明固定挂在根元素上。
 */

const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_RESOURCE_MAP_TYPE = 0x0180;
const RES_XML_START_NAMESPACE_TYPE = 0x0100;
const RES_XML_END_NAMESPACE_TYPE = 0x0101;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const RES_XML_END_ELEMENT_TYPE = 0x0103;
const RES_XML_CDATA_TYPE = 0x0104;

const TYPE_REFERENCE = 0x01;
const TYPE_STRING = 0x03;
const TYPE_FLOAT = 0x04;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
const TYPE_BOOL = 0x12;

interface StringPool {
  strings: string[];
  /** UTF-8 编码标记（android:stringPool 的 flags bit 8） */
  isUtf8: boolean;
}

function parseStringPool(buffer: Buffer, offset: number, chunkSize: number): StringPool {
  const stringCount = buffer.readUInt32LE(offset + 8);
  const flags = buffer.readUInt32LE(offset + 16);
  const stringsStart = buffer.readUInt32LE(offset + 20);
  const isUtf8 = (flags & 0x100) !== 0;

  const offsets: number[] = [];
  for (let i = 0; i < stringCount; i++) {
    offsets.push(buffer.readUInt32LE(offset + 28 + i * 4));
  }

  const strings: string[] = [];
  for (let i = 0; i < stringCount; i++) {
    const pos = offset + stringsStart + offsets[i];
    if (pos >= offset + chunkSize) { strings.push(''); continue; }
    try {
      if (isUtf8) {
        // UTF-8 pool: [u8 len16(字符数, 可能两字节)] [u8 byteLen] [bytes] [00]
        let charLen = buffer.readUInt8(pos);
        let dataPos = pos + 1;
        if (charLen & 0x80) { charLen = ((charLen & 0x7f) << 8) | buffer.readUInt8(pos + 1); dataPos = pos + 2; }
        let byteLen = buffer.readUInt8(dataPos);
        dataPos += 1;
        if (byteLen & 0x80) { byteLen = ((byteLen & 0x7f) << 8) | buffer.readUInt8(dataPos); dataPos += 1; }
        strings.push(buffer.toString('utf8', dataPos, dataPos + byteLen));
      } else {
        // UTF-16 pool: [u16 charLen(可能两字节)] [chars] [0000]
        let charLen = buffer.readUInt16LE(pos);
        let dataPos = pos + 2;
        if (charLen & 0x8000) { charLen = ((charLen & 0x7fff) << 16) | buffer.readUInt16LE(pos + 2); dataPos = pos + 4; }
        strings.push(buffer.toString('utf16le', dataPos, dataPos + charLen * 2));
      }
    } catch {
      strings.push('');
    }
  }
  return { strings, isUtf8 };
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

interface RawAttr {
  ns: number;
  name: number;
  rawValue: number;
  type: number;
  data: number;
}

const U32_NONE = 0xFFFFFFFF;

function parseAttributes(buffer: Buffer, attrStart: number, attrSize: number, attrCount: number): RawAttr[] {
  const attrs: RawAttr[] = [];
  for (let i = 0; i < attrCount; i++) {
    const o = attrStart + i * attrSize;
    if (o + 20 > buffer.length) break;
    attrs.push({
      ns: buffer.readUInt32LE(o),
      name: buffer.readUInt32LE(o + 4),
      rawValue: buffer.readUInt32LE(o + 8),
      type: buffer.readUInt8(o + 15),
      data: buffer.readUInt32LE(o + 16)
    });
  }
  return attrs;
}

/**
 * 将 AXML buffer 转为缩进 XML 文本。解析失败返回 null（调用方按二进制处理）。
 * maxChars 限制输出长度，超出时截断并追加省略标记。
 */
export function axmlToText(buffer: Buffer, maxChars = 512 * 1024): string | null {
  try {
    if (buffer.length < 16) return null;

    // 文件头 8 字节（type=0x0003, headerSize=8）+ 4 字节 fileSize
    let offset = 8;

    let pool: StringPool | null = null;
    const resourceMap = new Map<number, number>();
    const nsPrefixToUri = new Map<string, string>();
    const pendingNs: string[] = [];

    const out: string[] = [];
    const stack: string[] = [];
    let indent = 0;
    let totalChars = 0;
    let truncated = false;

    const getString = (idx: number): string => {
      if (!pool || idx < 0 || idx >= pool.strings.length) return '';
      return pool.strings[idx] || '';
    };

    const push = (line: string) => {
      if (truncated) return;
      totalChars += line.length + 1;
      out.push(line);
      if (totalChars > maxChars) {
        out.push('<!-- ... 内容过长已截断 ... -->');
        truncated = true;
      }
    };

    while (offset + 8 <= buffer.length && !truncated) {
      const type = buffer.readUInt16LE(offset);
      const headerSize = buffer.readUInt16LE(offset + 2);
      const chunkSize = buffer.readUInt32LE(offset + 4);
      if (chunkSize < 8 || offset + chunkSize > buffer.length) break;

      if (type === RES_STRING_POOL_TYPE) {
        pool = parseStringPool(buffer, offset, chunkSize);
      } else if (type === RES_XML_RESOURCE_MAP_TYPE) {
        const count = Math.floor((chunkSize - headerSize) / 4);
        for (let i = 0; i < count; i++) {
          resourceMap.set(i, buffer.readUInt32LE(offset + headerSize + i * 4));
        }
      } else if (type === RES_XML_START_NAMESPACE_TYPE) {
        const prefix = getString(buffer.readInt32LE(offset + headerSize));
        const uri = getString(buffer.readInt32LE(offset + headerSize + 4));
        nsPrefixToUri.set(prefix, uri);
        pendingNs.push(prefix);
      } else if (type === RES_XML_START_ELEMENT_TYPE) {
        // ResXMLTree_attrExt（chunk 头之后）: ns(4) name(4) attributeStart(2)
        // attributeSize(2) attributeCount(2) idIndex(2) classIndex(2) styleIndex(2)
        const body = offset + headerSize;
        const name = getString(buffer.readUInt32LE(body + 4));
        const attributeStart = buffer.readUInt16LE(body + 8);
        const attributeSize = buffer.readUInt16LE(body + 10) || 20;
        const attributeCount = buffer.readUInt16LE(body + 12);
        const attrs = parseAttributes(buffer, body + attributeStart, attributeSize, attributeCount);

        const attrText = attrs
          .map(a => {
            // a.ns 是 string pool 中命名空间 URI 字符串的索引，0xFFFFFFFF 表示无命名空间
            let prefix: string | undefined;
            if (a.ns !== U32_NONE) {
              const uri = getString(a.ns);
              prefix = [...nsPrefixToUri.entries()].find(([, u]) => u === uri)?.[0];
            }
            const attrName = getString(a.name);
            const qName = prefix ? `${prefix}:${attrName}` : attrName;
            return `${qName}="${escapeAttr(formatValue(a, getString, resourceMap))}"`;
          })
          .join(' ');

        // 挂载根元素的命名空间声明
        let nsDecls = '';
        if (stack.length === 0 && pendingNs.length > 0) {
          nsDecls = pendingNs
            .map(p => `xmlns:${p}="${escapeAttr(nsPrefixToUri.get(p) || '')}"`)
            .join(' ');
        }

        push('  '.repeat(indent) + `<${name}${nsDecls ? ' ' + nsDecls : ''}${attrText ? ' ' + attrText : ''}>`);
        stack.push(name);
        indent++;
      } else if (type === RES_XML_END_ELEMENT_TYPE) {
        const body = offset + headerSize;
        const name = getString(buffer.readUInt32LE(body + 4));
        indent = Math.max(0, indent - 1);
        const openName = stack.pop();
        const closeName = name || openName || '';
        const expectedOpen = '  '.repeat(indent) + `<${openName}`;
        const last = out.length - 1;
        // 无子内容的元素合并为自闭合形式，提升 diff 可读性（开标签可能带属性）
        if (!truncated && last >= 0 && openName && out[last].startsWith(expectedOpen) && out[last].endsWith('>')) {
          out[last] = out[last].slice(0, -1) + '/>';
        } else {
          push('  '.repeat(indent) + `</${closeName}>`);
        }
      } else if (type === RES_XML_CDATA_TYPE) {
        const dataOffset = buffer.readUInt32LE(offset + headerSize);
        // CDATA chunk: data 引用 string pool 索引
        const text = escapeText(getString(dataOffset));
        if (text.trim()) push('  '.repeat(indent) + text);
      }
      // END_NAMESPACE / 其他：跳过

      offset += chunkSize;
    }

    if (!pool) return null;
    return out.join('\n');
  } catch {
    return null;
  }
}

function formatValue(
  a: RawAttr,
  getString: (idx: number) => string,
  resourceMap: Map<number, number>
): string {
  // 优先取原样字符串（编译时保留的 raw 值）
  if (a.rawValue !== U32_NONE) {
    const raw = getString(a.rawValue);
    if (raw !== '') return raw;
  }
  switch (a.type) {
    case TYPE_STRING:
      return getString(a.data);
    case TYPE_REFERENCE: {
      if (a.data === 0) return '@null';
      const resId = resourceMap.get(a.data);
      return resId ? `@ref/0x${resId.toString(16)}` : `@android:0x${a.data.toString(16)}`;
    }
    case TYPE_FLOAT: {
      const buf = Buffer.alloc(4);
      buf.writeUInt32LE(a.data, 0);
      return buf.readFloatLE(0).toString();
    }
    case TYPE_INT_DEC:
      return String(a.data | 0);
    case TYPE_INT_HEX:
      return '0x' + a.data.toString(16);
    case TYPE_BOOL:
      return a.data === 0 ? 'false' : 'true';
    default:
      // 未知类型：原样十六进制，保证 diff 稳定
      return `?0x${a.data.toString(16)}`;
  }
}
