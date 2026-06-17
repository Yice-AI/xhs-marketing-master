const normalizeLineBreaks = (value: string) => value.replace(/\r\n?/g, '\n');

export const sanitizeMarkdownForXhs = (value: string): string => {
  const normalized = normalizeLineBreaks(String(value || ''));

  const stripped = normalized
    .replace(/```[\s\S]*?```/g, (block) =>
      block
        .replace(/^```[^\n]*\n?/g, '')
        .replace(/\n?```$/g, '')
    )
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1$2')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, '$1$2')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^(\s*\d+)\.\s+/gm, '$1. ')
    .replace(/\n{3,}/g, '\n\n');

  return stripped.trim();
};

export const prepareXhsBodyForPublish = (value: string): string => {
  const sanitized = sanitizeMarkdownForXhs(value);
  return sanitized.replace(/(?:\s*#[^\s#]+)+\s*$/, '').trim();
};

export const normalizeXhsTag = (value: string): string => (
  String(value || '')
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, '')
    .replace(/[，,、;；]+$/g, '')
);

export const normalizeXhsTags = (values?: string[] | null): string[] => {
  const seen = new Set<string>();
  const normalized: string[] = [];
  (values || []).forEach((value) => {
    const tag = normalizeXhsTag(value);
    if (!tag || seen.has(tag)) return;
    seen.add(tag);
    normalized.push(tag);
  });
  return normalized;
};
