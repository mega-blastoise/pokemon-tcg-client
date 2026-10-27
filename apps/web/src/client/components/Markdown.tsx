/** @module markdown Small safe markdown renderer; backticked card ids become links. */
import type { ReactNode } from "react";

// Canonical card ids look like set-number: sv3pt5-6, base1-4, swsh12pt5gg-GG01.
const CARD_ID = /^[a-z0-9.]+-[A-Za-z0-9!?]+$/;

/** Inline spans: **bold**, *italic*, `code`, [text](url). */
function inline(
  text: string,
  onCard: (id: string) => void,
  key: string,
): ReactNode[] {
  const pattern =
    /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)\s]+\))/g;
  return text.split(pattern).map((part, i) => {
    const k = `${key}-${i}`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4)
      return <strong key={k}>{inline(part.slice(2, -2), onCard, k)}</strong>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      const code = part.slice(1, -1);
      return CARD_ID.test(code) ? (
        <button
          key={k}
          type="button"
          className="card-chip"
          onClick={() => onCard(code)}
        >
          {code}
        </button>
      ) : (
        <code key={k}>{code}</code>
      );
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2)
      return <em key={k}>{part.slice(1, -1)}</em>;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link && /^https?:\/\//.test(link[2] ?? ""))
      return (
        <a key={k} href={link[2]} target="_blank" rel="noreferrer">
          {link[1]}
        </a>
      );
    return part;
  });
}

/** Block structure: headings, nested lists, fences, tables-as-text, paragraphs. */
export function Markdown({
  text,
  onCard,
}: {
  text: string;
  onCard: (id: string) => void;
}) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let list: { ordered: boolean; items: ReactNode[] } | null = null;
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) {
      const k = `p${blocks.length}`;
      blocks.push(<p key={k}>{inline(paragraph.join(" "), onCard, k)}</p>);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      const k = `l${blocks.length}`;
      blocks.push(
        list.ordered ? (
          <ol key={k}>{list.items}</ol>
        ) : (
          <ul key={k}>{list.items}</ul>
        ),
      );
      list = null;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim().startsWith("```")) {
      flushParagraph();
      flushList();
      const body: string[] = [];
      while (++i < lines.length && !(lines[i] ?? "").trim().startsWith("```"))
        body.push(lines[i] ?? "");
      blocks.push(<pre key={`c${blocks.length}`}>{body.join("\n")}</pre>);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const k = `h${blocks.length}`;
      blocks.push(<h4 key={k}>{inline(heading[2] ?? "", onCard, k)}</h4>);
      continue;
    }
    const item = /^\s*([-*•]|\d+\.)\s+(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      const ordered = /\d/.test(item[1] ?? "");
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      const k = `i${blocks.length}-${list.items.length}`;
      list.items.push(<li key={k}>{inline(item[2] ?? "", onCard, k)}</li>);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return <div className="md">{blocks}</div>;
}
