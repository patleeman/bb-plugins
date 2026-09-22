import type { JSX as ReactJSX } from "react";

// emoji-picker-react 4.22 uses the pre-React-19 name in two return types.
// Keep its declarations checked while mapping that name to BB's React types.
declare global {
  namespace JSX {
    interface Element extends ReactJSX.Element {}
  }
}
