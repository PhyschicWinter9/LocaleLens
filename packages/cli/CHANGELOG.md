# localelens

## 0.7.0

### Minor Changes

- next-intl translation resolution: dotted namespaces (`landing.hero`) resolve to their owning file and JSON path, existing translations are editable without a source rewrite, and failures carry stage-specific codes. Adds aliases, `t.rich`, `getTranslations({ namespace })`, conditionals, prop and dynamic-key resolution by on-screen text, and `localelens doctor --translations` (read-only).
