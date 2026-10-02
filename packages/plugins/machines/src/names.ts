/**
 * The fleet's names, and nothing else: no schema, no engine helper, no runtime import. Every
 * half reads its id and door names from here, so a portable Worker build and a hardened server
 * guest name `core.machines` without pulling the engine's browser registry into either.
 *
 * The door names are built from the id rather than spelled: the chrome that dispatches them and
 * the `data-action` attribute that names them in the DOM (AXIOMS.md §Foundation law and
 * REGISTRY.md §Foundation) cannot drift from the declaration. `core.keys` set this precedent.
 */
export const MACHINES_PLUGIN_ID = "core.machines";
export const MACHINES_ENROLL_ACTION = `${MACHINES_PLUGIN_ID}.enroll`;
export const MACHINES_REVOKE_ACTION = `${MACHINES_PLUGIN_ID}.revoke`;
export const MACHINES_FORGET_ACTION = `${MACHINES_PLUGIN_ID}.forget`;
export const MACHINES_LIST_HOST_VIEWS_ACTION = `${MACHINES_PLUGIN_ID}.listHostViews`;
export const MACHINES_SET_HOST_VIEW_ACTION = `${MACHINES_PLUGIN_ID}.setHostView`;
export const MACHINES_REMOVE_HOST_VIEW_ACTION = `${MACHINES_PLUGIN_ID}.removeHostView`;
