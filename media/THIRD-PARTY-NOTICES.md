# Third-party notices

Files bundled in `media/` that this extension did not write, with their licences.
All are MIT. The extension's own licence is in `/LICENSE`.

## markdown-it 14.3.3 (`markdown-it.min.js`)

https://github.com/markdown-it/markdown-it
Copyright (c) 2014 Vitaly Puzrin, Alex Kocharin. MIT License.

The Markdown renderer the viewer uses, the same one VS Code's and Kiro's built-in
Markdown preview use. The browser bundle, unmodified.

## markdown-it-task-lists 2.1.1 (`markdown-it-task-lists.min.js`)

https://github.com/revin/markdown-it-task-lists
Copyright (c) 2016 Revin Guillen. ISC License.

Renders `- [ ]` / `- [x]` as checkboxes. The browser bundle, unmodified.

## Markdown preview stylesheet (typography rules inside `src/extension.js`)

The viewer's typography (heading sizes and rules, paragraph and list spacing, table,
blockquote and code block treatment) follows `markdown.css` from VS Code's
`markdown-language-features` extension, which Kiro ships.
Copyright (c) Microsoft Corporation. MIT License.

Scoped under `.preview` and with this extension's inline-code colours, which were
chosen for contrast on both of Kiro's themes (see docs/v2-support.md).

## mermaid 11.14.0 (`mermaid.min.js`)

https://github.com/mermaid-js/mermaid
Copyright (c) 2014 - 2022 Knut Sveidqvist. MIT License.

Renders ```` ```mermaid ```` blocks. The browser bundle, unmodified.

---

MIT License text (markdown-it, mermaid, VS Code):

Permission is hereby granted, free of charge, to any person obtaining a copy of this
software and associated documentation files (the "Software"), to deal in the Software
without restriction, including without limitation the rights to use, copy, modify,
merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be included in all copies
or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

ISC License text (markdown-it-task-lists):

Permission to use, copy, modify, and/or distribute this software for any purpose with
or without fee is hereby granted, provided that the above copyright notice and this
permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD
TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN
NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR
CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR
PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
