import { expect, test } from "bun:test";
import type { Principal } from "@manifold/protocol";
import { projectLocalPresence } from "./presence-projection.ts";

const self: Principal = {
  id: "self",
  kind: "human",
  name: "Self",
  color: "#112233",
};
const remote: Principal = {
  id: "remote",
  kind: "human",
  name: "Remote",
  color: "#445566",
};

test("moves local presence immediately without moving remote principals", () => {
  expect(
    projectLocalPresence(
      [
        { padId: "old", principals: [self] },
        { padId: "new", principals: [remote] },
      ],
      self,
      "new",
    ),
  ).toEqual([{ padId: "new", principals: [remote, self] }]);
});
