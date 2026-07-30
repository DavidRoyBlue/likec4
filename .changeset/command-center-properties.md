---
'@likec4/core': patch
'@likec4/language-server': patch
'@likec4/vite-plugin': patch
'@likec4/diagram': patch
'likec4': patch
---

Edit element properties (title, description, technology, tags) and view properties (title, description) directly from the diagram in `likec4 start`. Edits are written back into the `.c4` source as precise text edits. Failed edits now show a notification and the diagram restores to the source state; the editor sync queue acknowledges applied changes instead of using a fixed timer.
