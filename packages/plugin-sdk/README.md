# OpenBoard Plugin SDK

Typed contracts for OpenBoard manifest v2 plugins. Plugins run in an opaque sandbox and request node, asset, AI, or panel capabilities through the host bridge. Provider credentials remain in the OpenBoard host and are never returned to plugins.

```ts
import { getOpenBoard } from "@openboard/plugin-sdk";

const openboard = getOpenBoard();
openboard.ready();

const result = await openboard.ai.text({ prompt: "Summarize this node" });
await openboard.node.patch({ state: { summary: result.text } });
```

Declare every capability in the manifest `permissions` array. Installation requires explicit consent for each newly requested permission.
