/**
 * `@manifold/ui/frames` — THE PORTABLE HALF OF THE DESIGN SYSTEM (ADR 0053).
 *
 * The components a portable web contribution may render in BOTH execution modes, and the
 * frame seam that tells them which one they are in. Every export is the same implementation
 * `@manifold/ui` exports — a Worker build maps `@manifold/ui` here, so one component source
 * compiles for the page and for a Worker without a second copy of anything. What is absent is
 * absent on purpose: the stylesheet (a Worker has no document to load it into, and the host
 * paints with its own), the behavior-engine components that need a DOM and a portal
 * (`Disclosure`, `Popover`, `ScrollRegion`), and the layout primitives whose arrangement is
 * CSS the vocabulary does not carry. Importing one of those into a portable build fails there,
 * by name, rather than rendering something the host would have to guess at.
 */
export {
  FRAME_ELEMENT_PREFIX,
  FrameModeProvider,
  useFrameMode,
  type FrameModeProviderProps,
} from "./frame-mode.tsx";
export { ControlIcon, ItemIcon, type ControlKind, type IconProps } from "./icons.tsx";
export {
  Cluster,
  Stack,
  type ClusterProps,
  type LayoutProps,
  type StackProps,
} from "./layout.tsx";
export {
  Badge,
  Button,
  Code,
  Divider,
  Empty,
  Heading,
  Input,
  List,
  Select,
  Spinner,
  Text,
  Toggle,
  type BadgeProps,
  type ButtonProps,
  type CodeProps,
  type DividerProps,
  type EmptyProps,
  type HeadingProps,
  type InputProps,
  type ListItem,
  type ListProps,
  type SelectProps,
  type SpinnerProps,
  type TextProps,
  type ToggleProps,
  type VocabularyMeta,
  type VocabularyText,
} from "./vocabulary.tsx";
