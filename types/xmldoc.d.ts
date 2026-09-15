/**
 * xmldoc 模块类型声明（xmldoc 包不自带类型）
 */
declare module 'xmldoc' {
  export class XMLNode {
    name: string;
    text(): string;
    attr(name: string): string | null;
    hasAttr(name: string): boolean;
    get attributes(): Record<string, string>;
    parent: XMLNode | null;
    querySelector(selector: string): XMLNode | null;
    querySelectorAll(selector: string): XMLNode[];
    childNodes: XMLNode[];
  }
  export class XMLDocument extends XMLNode {
    constructor(content: string | Buffer);
    root: XMLNode;
  }
}
