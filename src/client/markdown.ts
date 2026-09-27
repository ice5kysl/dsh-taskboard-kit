/**
 * A mini markdown renderer for the task drawer — zero dependencies, XSS-safe
 * by construction.
 *
 * Task details and comments are multi-source input (humans and every agent
 * that touches the board), so the pipeline escapes FIRST and only ever injects
 * tags it created itself:
 *
 *   1. inline code spans are extracted into placeholders (their content is
 *      escaped once and never re-interpreted);
 *   2. the remaining text is HTML-escaped (& < > ");
 *   3. the only markup produced afterwards is ours: links (http/https only —
 *      javascript: and friends render as literal text), bold, italic;
 *   4. block level: paragraphs (single newline = <br>), # headings, -/* and
 *      1. lists, ``` fenced code, > quotes.
 *
 * The result is a sanitized HTML string for dangerouslySetInnerHTML — every
 * byte of user input has passed through escapeHtml exactly once, and every
 * attribute value is escaped before it lands inside quotes.
 *
 * @module dsh-taskboard-kit/client-markdown
 */

/** Escape the four characters that matter for text + double-quoted attributes. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Only http/https links ever become anchors; anything else stays literal. */
const SAFE_URL = /^https?:\/\//i

/** Inline formatting of one raw text fragment (already block-positioned). */
function inline(raw: string): string {
  // 1. Inline code spans ride out the rest of the pipeline as placeholders:
  //    their content is escaped and never sees bold/italic/link rules.
  const codes: string[] = []
  let text = raw.replace(/`([^`]+)`/g, (_match, code: string) => {
    codes.push(`<code>${escapeHtml(code)}</code>`)
    return `\u0000${codes.length - 1}\u0000`
  })
  // 2. Everything the user wrote becomes inert text.
  text = escapeHtml(text)
  // 3. Links: [label](url) with a scheme whitelist; target/rel so a link can
  //    never hijack or phone home from the webview. The url sits inside a
  //    double-quoted attribute and was escaped in step 2 (no raw quotes).
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, url: string) =>
    SAFE_URL.test(url) ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>` : match,
  )
  // 4. Bold before italic so ** wins over *.
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  // 5. Restore the protected code spans.
  text = text.replace(/\u0000(\d+)\u0000/g, (_match, n: string) => codes[Number(n)] ?? '')
  return text
}

/** Render markdown source to a sanitized HTML string. */
export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  const at = (n: number): string => lines[n] ?? ''

  const isFence = (line: string): boolean => /^```/.test(line)
  const isUl = (line: string): boolean => /^\s*[-*]\s+/.test(line)
  const isOl = (line: string): boolean => /^\s*\d+\.\s+/.test(line)
  const isQuote = (line: string): boolean => /^>\s?/.test(line)
  const isHeading = (line: string): boolean => /^#{1,6}\s+/.test(line)
  const isBlockStart = (line: string): boolean =>
    isFence(line) || isHeading(line) || isUl(line) || isOl(line) || isQuote(line)

  while (i < lines.length) {
    const line = at(i)

    // Fenced code block: content is escaped verbatim, no inline rules.
    if (isFence(line)) {
      i += 1
      const code: string[] = []
      while (i < lines.length && !isFence(at(i))) {
        code.push(at(i))
        i += 1
      }
      i += 1 // the closing fence (or EOF)
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = (heading[1] ?? '#').length
      out.push(`<h${level}>${inline(heading[2] ?? '')}</h${level}>`)
      i += 1
      continue
    }

    if (isUl(line)) {
      const items: string[] = []
      while (i < lines.length && isUl(at(i))) {
        items.push(at(i).replace(/^\s*[-*]\s+/, ''))
        i += 1
      }
      out.push(`<ul>${items.map((item) => `<li>${inline(item)}</li>`).join('')}</ul>`)
      continue
    }

    if (isOl(line)) {
      const items: string[] = []
      while (i < lines.length && isOl(at(i))) {
        items.push(at(i).replace(/^\s*\d+\.\s+/, ''))
        i += 1
      }
      out.push(`<ol>${items.map((item) => `<li>${inline(item)}</li>`).join('')}</ol>`)
      continue
    }

    if (isQuote(line)) {
      const quoted: string[] = []
      while (i < lines.length && isQuote(at(i))) {
        quoted.push(at(i).replace(/^>\s?/, ''))
        i += 1
      }
      out.push(`<blockquote>${quoted.map((row) => inline(row)).join('<br>')}</blockquote>`)
      continue
    }

    if (line.trim() === '') {
      i += 1
      continue
    }

    // Paragraph: until a blank line or the start of another block.
    const para: string[] = []
    while (i < lines.length && at(i).trim() !== '' && !isBlockStart(at(i))) {
      para.push(at(i))
      i += 1
    }
    out.push(`<p>${para.map(inline).join('<br>')}</p>`)
  }
  return out.join('')
}
