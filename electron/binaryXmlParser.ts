/**
 * binaryXmlParser.ts — Android 二进制 XML (AXML) 解析器
 *
 * 不依赖 apktool/Java，直接从 APK 内的原始 AndroidManifest.xml
 * 提取权限、元数据、组件信息。用于 apktool 不可用时的降级路径。
 *
 * 格式参考：https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/libs/androidfw/ResXMLParser.cpp
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ParsedManifest {
  package: string | null;
  versionCode: string | null;
  versionName: string | null;
  platformBuildVersionCode: string | null;
  platformBuildVersionName: string | null;
  installLocation: string | null;
  minSdkVersion: string | null;
  targetSdkVersion: string | null;
  maxSdkVersion: string | null;
  applicationLabel: string | null;
  applicationIcon: string | null;
  applicationTheme: string | null;
  permissions: Array<{ name: string; maxSdkVersion: string | null; line: number }>;
  activities: Array<{ name: string; exported: boolean | null; enabled: boolean | null; line: number }>;
  services: Array<{ name: string; exported: boolean | null; enabled: boolean | null; line: number }>;
  receivers: Array<{ name: string; exported: boolean | null; enabled: boolean | null; line: number }>;
  providers: Array<{ name: string; exported: boolean | null; enabled: boolean | null; authority: string | null; line: number }>;
  metaData: Array<{ name: string; value: string | null; line: number }>;
  rawElements: string[]; // debug: all element names encountered
}

// Android XML chunk types
const CHUNK_STRING_POOL = 0x0001;
const CHUNK_RESOURCE_MAP = 0x0002;
const CHUNK_XML_START_TAG = 0x0102;
const CHUNK_XML_END_TAG = 0x0103;
const CHUNK_XML_START_NS = 0x0100;
const CHUNK_XML_END_NS = 0x0101;

interface StringPool {
  strings: string[];
  utf8: boolean;
}

interface XmlAttribute {
  nsIndex: number;
  nameIndex: number;
  rawValueIndex: number;
  typedDataType: number;
  typedData: number;
}

interface XmlStartTag {
  lineNumber: number;
  nsIndex: number;
  nameIndex: number;
  attributes: XmlAttribute[];
}

/**
 * 检测是否为 Android 二进制 XML 格式
 */
export function isBinaryXml(buf: Buffer): boolean {
  if (buf.length < 8) return false;
  const type = buf.readUInt16LE(0);
  const headerSize = buf.readUInt16LE(2);
  // 二进制 XML: type=0x0003, headerSize=0x0008 (XML header 16 bytes)
  // 第一层 chunk 是 0x0003 (XML) 或 0x0001 (STRING_POOL)
  return (type === 0x0003 && headerSize === 8) || type === CHUNK_STRING_POOL;
}

/**
 * 解析 String Pool chunk，返回字符串数组
 */
function parseStringPool(buf: Buffer, offset: number, chunkSize: number): StringPool | null {
  const stringCount = buf.readUInt32LE(offset + 8);
  const styleCount = buf.readUInt32LE(offset + 12);
  const flags = buf.readUInt32LE(offset + 16);
  const stringsStart = buf.readUInt32LE(offset + 20);
  // stylesStart = buf.readUInt32LE(offset + 24); // 不用

  const utf8 = (flags & 0x100) !== 0;
  const strings: string[] = [];
  const stringOffsets: number[] = [];

  const offsetsStart = offset + 28; // after header
  for (let i = 0; i < stringCount; i++) {
    stringOffsets.push(buf.readUInt32LE(offsetsStart + i * 4));
  }

  const stringsBase = offset + stringsStart;
  for (let i = 0; i < stringCount; i++) {
    let pos = stringsBase + stringOffsets[i];
    let str = '';

    if (utf8) {
      // UTF-8: first 1 or 2 bytes = char count, next 1 or 2 bytes = byte count
      let charCount: number;
      const firstByte = buf[pos++];
      if (firstByte & 0x80) {
        charCount = ((firstByte & 0x7F) << 8) | buf[pos++];
      } else {
        charCount = firstByte;
      }
      // byte count (1 or 2 bytes)
      let byteCount: number;
      const byteCountFirst = buf[pos++];
      if (byteCountFirst & 0x80) {
        byteCount = ((byteCountFirst & 0x7F) << 8) | buf[pos++];
      } else {
        byteCount = byteCountFirst;
      }
      // Use Buffer's built-in UTF-8 decoder (handles multi-byte chars correctly)
      if (byteCount > 0 && pos + byteCount <= buf.length) {
        str = buf.toString('utf8', pos, pos + byteCount);
        pos += byteCount;
      }
    } else {
      // UTF-16LE
      let charCount: number;
      const firstWord = buf.readUInt16LE(pos);
      pos += 2;
      if (firstWord & 0x8000) {
        charCount = ((firstWord & 0x7FFF) << 16) | buf.readUInt16LE(pos);
        pos += 2;
      } else {
        charCount = firstWord;
      }
      for (let c = 0; c < charCount; c++) {
        str += String.fromCharCode(buf.readUInt16LE(pos));
        pos += 2;
      }
    }
    strings.push(str);
  }

  return { strings, utf8 };
}

/**
 * 解析 Resource Map chunk（资源 ID → 字符串索引映射）
 */
function parseResourceMap(buf: Buffer, offset: number, chunkSize: number): Map<number, number> {
  const entryCount = buf.readUInt32LE(offset + 8);
  const map = new Map<number, number>();
  const entriesStart = offset + 12;
  for (let i = 0; i < entryCount; i++) {
    const id = buf.readUInt32LE(entriesStart + i * 8);
    const nameIndex = buf.readUInt32LE(entriesStart + i * 8 + 4);
    map.set(id, nameIndex);
  }
  return map;
}

/**
 * 解析 Start Tag chunk
 */
function parseStartTag(buf: Buffer, offset: number, chunkSize: number): XmlStartTag | null {
  const lineNumber = buf.readUInt32LE(offset + 8);
  // lineColumn = buf.readUInt32LE(offset + 12);
  // extension = buf.readUInt32LE(offset + 16);
  const nsIndex = buf.readUInt32LE(offset + 20);
  const nameIndex = buf.readUInt32LE(offset + 24);
  const attributeStart = buf.readUInt32LE(offset + 28);
  const attributeSize = buf.readUInt32LE(offset + 32);
  const attributeCount = buf.readUInt32LE(offset + 36);

  const attributes: XmlAttribute[] = [];
  const attrBase = offset + attributeStart;
  for (let i = 0; i < attributeCount; i++) {
    const attrOffset = attrBase + i * attributeSize;
    const ns = buf.readUInt32LE(attrOffset);
    const name = buf.readUInt32LE(attrOffset + 4);
    const rawValue = buf.readUInt32LE(attrOffset + 8);
    // typed value starts at +12
    const tvSize = buf.readUInt32LE(attrOffset + 12);
    const tvDataType = buf.readUInt8(attrOffset + 16);
    const tvData = buf.readUInt32LE(attrOffset + 17);
    attributes.push({ nsIndex: ns, nameIndex: name, rawValueIndex: rawValue, typedDataType: tvDataType, typedData: tvData });
  }

  return { lineNumber, nsIndex, nameIndex, attributes };
}

/**
 * 从 raw buffer 中解析所有 XML chunk
 */
export function parseBinaryXml(buffer: Buffer): {
  stringPool: StringPool | null;
  resourceMap: Map<number, number>;
  tags: XmlStartTag[];
} {
  const result = {
    stringPool: null as StringPool | null,
    resourceMap: new Map<number, number>(),
    tags: [] as XmlStartTag[]
  };

  if (buffer.length < 16) return result;

  let offset = 0;
  // Skip XML header (16 bytes: type=0x0003, headerSize=8, fileSize=4, 0, 0)
  const xmlType = buffer.readUInt16LE(0);
  if (xmlType === 0x0003) {
    offset = 16;
  }

  while (offset + 8 <= buffer.length) {
    const type = buffer.readUInt16LE(offset);
    const headerSize = buffer.readUInt16LE(offset + 2);
    const chunkSize = buffer.readUInt32LE(offset + 4);

    if (chunkSize < 8 || offset + chunkSize > buffer.length) break;

    switch (type) {
      case CHUNK_STRING_POOL: {
        result.stringPool = parseStringPool(buffer, offset, chunkSize);
        break;
      }
      case CHUNK_RESOURCE_MAP: {
        const rm = parseResourceMap(buffer, offset, chunkSize);
        rm.forEach((v, k) => result.resourceMap.set(k, v));
        break;
      }
      case CHUNK_XML_START_TAG: {
        const tag = parseStartTag(buffer, offset, chunkSize);
        if (tag) result.tags.push(tag);
        break;
      }
      // CHUNK_XML_END_TAG, CHUNK_XML_START_NS, CHUNK_XML_END_NS: skip
      default:
        break;
    }

    offset += chunkSize;
  }

  return result;
}

/**
 * 从解析结果中提取 manifest 信息
 */
export function extractManifest(parsed: {
  stringPool: StringPool | null;
  resourceMap: Map<number, number>;
  tags: XmlStartTag[];
}): ParsedManifest {
  const sp = parsed.stringPool;
  const getString = (idx: number): string => {
    if (!sp || idx < 0 || idx >= 0xFFFFFFFF || idx >= sp.strings.length) return '';
    return sp.strings[idx] || '';
  };

  const manifest: ParsedManifest = {
    package: null, versionCode: null, versionName: null,
    platformBuildVersionCode: null, platformBuildVersionName: null,
    installLocation: null, minSdkVersion: null, targetSdkVersion: null,
    maxSdkVersion: null, applicationLabel: null, applicationIcon: null,
    applicationTheme: null,
    permissions: [], activities: [], services: [], receivers: [],
    providers: [], metaData: [], rawElements: []
  };

  let currentElement = '';

  for (const tag of parsed.tags) {
    const elName = getString(tag.nameIndex);
    if (!elName) continue;
    manifest.rawElements.push(elName);

    // Build attribute map: name -> value
    const attrs: Record<string, string> = {};
    for (const attr of tag.attributes) {
      const attrName = getString(attr.nameIndex);
      // typedValue.data 可能是字符串索引（dataType=0x03 = STRING）或布尔值（0x10 = BOOLEAN）等
      let val = '';
      if (attr.typedDataType === 0x03) { // STRING
        val = getString(attr.typedData);
      } else if (attr.typedDataType === 0x10) { // BOOLEAN
        val = attr.typedData === 0 ? 'false' : 'true';
      } else if (attr.typedDataType === 0x12) { // NULL
        val = '';
      } else {
        // 尝试 rawValueIndex（直接字符串索引）
        val = getString(attr.rawValueIndex);
      }
      if (attrName && val) attrs[attrName] = val;
    }

    // Manifest element
    if (elName === 'manifest') {
      manifest.package = attrs['package'] || null;
      manifest.versionCode = attrs['android:versionCode'] || null;
      manifest.versionName = attrs['android:versionName'] || null;
      manifest.platformBuildVersionCode = attrs['android:platformBuildVersionCode'] || null;
      manifest.platformBuildVersionName = attrs['android:platformBuildVersionName'] || null;
      manifest.installLocation = attrs['android:installLocation'] || null;
    }

    // Uses-sdk
    if (elName === 'uses-sdk') {
      manifest.minSdkVersion = attrs['android:minSdkVersion'] || null;
      manifest.targetSdkVersion = attrs['android:targetSdkVersion'] || null;
      manifest.maxSdkVersion = attrs['android:maxSdkVersion'] || null;
    }

    // Uses-permission
    if (elName === 'uses-permission') {
      manifest.permissions.push({
        name: attrs['android:name'] || '',
        maxSdkVersion: attrs['android:maxSdkVersion'] || null,
        line: tag.lineNumber
      });
    }

    // Application
    if (elName === 'application') {
      manifest.applicationLabel = attrs['android:label'] || null;
      manifest.applicationIcon = attrs['android:icon'] || null;
      manifest.applicationTheme = attrs['android:theme'] || null;
    }

    // Activity
    if (elName === 'activity') {
      manifest.activities.push({
        name: attrs['android:name'] || '',
        exported: attrs['android:exported'] !== undefined ? (attrs['android:exported'] === 'true') : null,
        enabled: attrs['android:enabled'] !== undefined ? (attrs['android:enabled'] === 'true') : null,
        line: tag.lineNumber
      });
    }

    // Service
    if (elName === 'service') {
      manifest.services.push({
        name: attrs['android:name'] || '',
        exported: attrs['android:exported'] !== undefined ? (attrs['android:exported'] === 'true') : null,
        enabled: attrs['android:enabled'] !== undefined ? (attrs['android:enabled'] === 'true') : null,
        line: tag.lineNumber
      });
    }

    // Receiver
    if (elName === 'receiver') {
      manifest.receivers.push({
        name: attrs['android:name'] || '',
        exported: attrs['android:exported'] !== undefined ? (attrs['android:exported'] === 'true') : null,
        enabled: attrs['android:enabled'] !== undefined ? (attrs['android:enabled'] === 'true') : null,
        line: tag.lineNumber
      });
    }

    // Provider
    if (elName === 'provider') {
      manifest.providers.push({
        name: attrs['android:name'] || '',
        exported: attrs['android:exported'] !== undefined ? (attrs['android:exported'] === 'true') : null,
        enabled: attrs['android:enabled'] !== undefined ? (attrs['android:enabled'] === 'true') : null,
        authority: attrs['android:authority'] || null,
        line: tag.lineNumber
      });
    }

    // Meta-data
    if (elName === 'meta-data') {
      manifest.metaData.push({
        name: attrs['android:name'] || '',
        value: attrs['android:value'] || null,
        line: tag.lineNumber
      });
    }

    currentElement = elName;
  }

  return manifest;
}

/**
 * 检测 Buffer 是否为 Android 二进制 XML 格式
 */
export function isBinaryXmlBuffer(buf: Buffer): boolean {
  return isBinaryXml(buf);
}

/**
 * 从 Buffer 解析二进制 XML manifest，返回结构化数据
 */
export function parseBinaryXmlBuffer(buffer: Buffer): ParsedManifest | null {
  try {
    const parsed = parseBinaryXml(buffer);
    return extractManifest(parsed);
  } catch (err) {
    console.warn('[binaryXmlParser] buffer parse failed:', err);
    return null;
  }
}

/**
 * 从 APK 反编译目录中解析 AndroidManifest.xml
 * 自动检测文本/二进制格式
 */
export function parseManifestFromDir(dir: string): ParsedManifest | null {
  const manifestPath = path.join(dir, 'AndroidManifest.xml');
  if (!fs.existsSync(manifestPath)) return null;

  const buf = fs.readFileSync(manifestPath);

  if (!isBinaryXml(buf)) {
    // 不是二进制 XML — 可能是文本 XML（apktool 反编译产物）
    // 返回 null，由调用方使用 xmldoc 解析
    return null;
  }

  try {
    const parsed = parseBinaryXml(buf);
    const manifest = extractManifest(parsed);
    // 如果解析出了任何有效内容，返回
    if (manifest.package || manifest.permissions.length > 0 || manifest.activities.length > 0 || manifest.versionName) {
      return manifest;
    }
    // 解析结果为空，可能是解析失败
    console.warn('[binaryXmlParser] parsed manifest but got no useful data, elements:', manifest.rawElements.slice(0, 10));
    return manifest;
  } catch (err) {
    console.warn('[binaryXmlParser] parse failed:', err);
    return null;
  }
}
