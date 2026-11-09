---
packages: @parcha/pi-browser, @parcha/agentrun-serve
kind: fix
---
`web_fetch`'s text (a page read directly, `readPage`) leaves out what the page hides from everyone who reads it: an element with the `hidden` attribute, an inline `display:none` or `visibility:hidden`, a closed `<dialog>`, a class the page's own `<style>` sets to `display:none` or `visibility:hidden`, and the common pop-up and display-none utility classes (`mfp-hide`, `modal`, `d-none`, `hidden`, `hide`, `invisible`, `is-hidden`, `u-hidden`). A record page's help pop-ups, hidden until a click, were read as the record, so an agent took their boilerplate ("notice of intent to dissolve") for the company's own. Text only a screen reader reads (`sr-only`, `visually-hidden`, `wb-inv`, `screen-reader-text`) and text marked `aria-hidden` stay in the text: each is shown to someone. A hidden element that no end tag closes is still read. Pages read through Parallel's extract are unchanged.
