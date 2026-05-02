Vescavia — Gyanverse simple site

This folder contains a small static site scaffold for presenting sections about the backend.

Structure
- index.html — landing + navigation (loads pages client-side)
- styles.css — theme and layout
- script.js — simple page loader (loads files from pages/)
- pages/ — individual HTML fragments for content

How to run locally

1) Quick static server (Node):

```powershell
# from repository root
npx serve presentation/vescavia-gyanverse/site
```

2) Or open `presentation/vescavia-gyanverse/site/index.html` in a browser (some browsers block fetch for local files).

Adding new sections
- Add an HTML file to `pages/` (e.g., `pages/auth.html`).
- Add a link to the header nav in `index.html` (anchor with `data-link`).

Do you want me to:
- Add an `auth.html` and `db.html` starter pages?
- Add an SVG logo and branded assets?
