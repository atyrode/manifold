import "./styles.css";
import type { ElementProps, HostServices, PanelProps, SectionProps } from "@manifold/plugin";
import {
  FALLBACK_POLL_MS,
  INDEX_RESOURCE,
  useDocumentAccess,
  useElementHost,
  usePolledResource,
  type ContainerRendererProps,
  type DocumentAccessState,
} from "@manifold/plugin/hooks";
import { ContainerResponseSchema, type Container, type IndexEntry } from "@manifold/protocol";
import { ControlIcon, ItemIcon, NodeTitleBar } from "@manifold/ui";
import { useCallback, useState, type ReactElement } from "react";
import {
  decodeTextDocument,
  decodeTextDocumentRoute,
  encodeTextDocument,
  textDocumentPath,
  type TextDocumentRef,
} from "./document.ts";
import { TextEditor } from "./editor.tsx";
import { CreateTextResultSchema, TEXT_NAMESPACE } from "./index.ts";

type ReadyDocument = Extract<DocumentAccessState, { state: "ready" }>;

function AccessMessage({
  access,
}: {
  readonly access: Exclude<DocumentAccessState, ReadyDocument>;
}): ReactElement {
  switch (access.state) {
    case "idle":
      return <p className="text-documents__message">Choose a document home.</p>;
    case "loading":
      return (
        <p className="text-documents__message" role="status">
          Opening document home…
        </p>
      );
    case "unavailable":
      return (
        <p className="text-documents__message" role="status">
          Document unavailable: {access.reason}
        </p>
      );
  }
}

function DocumentBody({
  access,
  documentId,
}: {
  readonly access: ReadyDocument;
  readonly documentId: string;
}): ReactElement {
  const text = access.doc.sharedText(TEXT_NAMESPACE, documentId);
  if (text === null) {
    return (
      <p className="text-documents__message" role="status">
        This document is missing from its home. Its reference does not create a replacement.
      </p>
    );
  }
  return (
    <div className="text-documents__body">
      {!access.canWrite ? (
        <p className="text-documents__message">
          Read only — editing is not available at this document's home.
        </p>
      ) : null}
      <TextEditor text={text} canWrite={access.canWrite} editing />
    </div>
  );
}

/** A reference never gains authority from the surface displaying it. */
function TextElement({ id, data }: ElementProps): ReactElement {
  const host = useElementHost();
  const reference = decodeTextDocument(data["document"]);
  const editing = host.editingElementId === id;
  const access = useDocumentAccess(reference?.homeContainerId ?? null, {
    document: host.doc,
    mode: editing ? "occupant" : "spectator",
  });
  if (reference === null) {
    return (
      <p className="text-reference__message" role="status">
        Invalid document reference
      </p>
    );
  }
  if (access.state !== "ready") return <AccessMessage access={access} />;
  const text = access.doc.sharedText(TEXT_NAMESPACE, reference.documentId);
  if (text === null) {
    return (
      <p className="text-reference__message" role="status">
        Document missing from its home
      </p>
    );
  }
  const readOnly = !access.doc.sceneWriteAllowed;
  return (
    <div className={`text-reference${data["fitContent"] === true ? " text-reference--fit" : ""}`}>
      {readOnly ? <p className="text-reference__message">Read only at document home</p> : null}
      <TextEditor
        text={text}
        canWrite={access.canWrite}
        editing={editing}
        fitContent={data["fitContent"] === true}
        fontSize={typeof data["fontSize"] === "number" ? data["fontSize"] : 20}
        color={typeof data["color"] === "string" ? data["color"] : "#f8f9fa"}
        onBeginEditing={() => host.beginEditing(id)}
        onEndEditing={() => host.endEditing(id)}
      />
    </div>
  );
}

function OpenDocument({ reference }: { readonly reference: TextDocumentRef }): ReactElement {
  const access = useDocumentAccess(reference.homeContainerId, { mode: "occupant" });
  return access.state === "ready" ? (
    <DocumentBody access={access} documentId={reference.documentId} />
  ) : (
    <AccessMessage access={access} />
  );
}

function DocumentPage({
  host,
  reference,
}: {
  readonly host: HostServices;
  readonly reference: TextDocumentRef;
}): ReactElement {
  return (
    <section className="text-documents" aria-label="Text document">
      <NodeTitleBar
        icon={<ItemIcon kind="text" />}
        title={reference.documentId}
        defaultTitle="Text document"
        extraActions={
          <button
            type="button"
            className="text-documents__button"
            onClick={() => host.navigate("/text/")}
          >
            All documents
          </button>
        }
      />
      <p className="text-documents__home">Home: {reference.homeContainerId}</p>
      {host.assembly.enabled(TEXT_NAMESPACE) ? (
        <OpenDocument reference={reference} />
      ) : (
        <p className="text-documents__message" role="status">
          Text is disabled. Documents are retained and cannot be edited.
        </p>
      )}
    </section>
  );
}

/** Lists retained bodies, not the scene's visual elements. One selected home uses one lease. */
function DocumentHome({
  host,
  homeContainerId,
  client,
}: {
  readonly host: HostServices;
  readonly homeContainerId: string;
  readonly client?: ContainerRendererProps["client"];
}): ReactElement {
  const access = useDocumentAccess(homeContainerId, {
    mode: client?.spectator === true ? "spectator" : "occupant",
    ...(client === undefined ? {} : { document: client, binding: "mounted" as const }),
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (access.state !== "ready") return <AccessMessage access={access} />;
  const records = access.doc.sharedTexts(TEXT_NAMESPACE);
  const documentId = selectedId ?? records.keys().next().value ?? null;

  const create = async (): Promise<void> => {
    setCreating(true);
    setFailure(null);
    try {
      const outcome = await host.client.action("core.text.create", {
        home: { kind: "container", containerId: homeContainerId },
      });
      if (!outcome.ok) {
        setFailure(outcome.denial.message);
        return;
      }
      setSelectedId(CreateTextResultSchema.parse(outcome.result).documentId);
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : "Could not create the document");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="text-documents__collection">
      <div className="text-documents__toolbar">
        <label className="text-documents__choice">
          Document
          <select
            value={documentId ?? ""}
            onChange={(event) => setSelectedId(event.currentTarget.value)}
            disabled={records.size === 0}
          >
            {records.size === 0 ? <option value="">No documents in this home</option> : null}
            {documentId !== null && !records.has(documentId) ? (
              <option value={documentId}>Missing document</option>
            ) : null}
            {Array.from(records, ([id, record]) => (
              <option key={id} value={id}>
                {record.text.slice(0, 80).split("\n", 1)[0] || "Untitled document"} · {id}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="text-documents__button"
          data-action="core.text.create"
          disabled={!access.canWrite || creating}
          onClick={() => void create()}
        >
          <ControlIcon kind="add" /> {creating ? "Creating…" : "New document"}
        </button>
        {documentId !== null ? (
          <button
            type="button"
            className="text-documents__button"
            onClick={() =>
              host.navigate(textDocumentPath(encodeTextDocument(homeContainerId, documentId)))
            }
          >
            Open document route
          </button>
        ) : null}
      </div>
      {failure !== null ? (
        <p className="text-documents__message" role="alert">
          {failure}
        </p>
      ) : null}
      {documentId === null ? (
        <p className="text-documents__message">
          This home contains no text documents.
          {access.canWrite ? " Create one to begin." : " You have read-only access."}
        </p>
      ) : (
        <DocumentBody access={access} documentId={documentId} />
      )}
    </div>
  );
}

function DocumentBrowser({ host }: { readonly host: HostServices }): ReactElement {
  const [homeId, setHomeId] = useState<string | null>(null);
  const [createdHome, setCreatedHome] = useState<Container | null>(null);
  const [homeName, setHomeName] = useState("");
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [indexFailure, setIndexFailure] = useState<string | null>(null);
  const enabled = host.assembly.enabled(TEXT_NAMESPACE);
  const fetchIndex = useCallback(() => host.client.index(), [host.client]);
  const { value: entries, refresh } = usePolledResource<readonly IndexEntry[] | null>(
    fetchIndex,
    FALLBACK_POLL_MS,
    {
      key: INDEX_RESOURCE,
      initial: null,
      enabled,
      topics: host.topics.index,
      events: host.client,
      onError: (reason) =>
        setIndexFailure(reason instanceof Error ? reason.message : "Could not read document homes"),
      onSuccess: () => setIndexFailure(null),
    },
  );
  const homes = (entries ?? []).flatMap((entry) =>
    entry.kind === "container" ? [entry.container] : [],
  );
  if (createdHome !== null && !homes.some((home) => home.id === createdHome.id))
    homes.push(createdHome);
  const selectedHomeId =
    homeId ??
    host.containerId ??
    homes.find((home) => home.discipline === "text-home")?.id ??
    homes[0]?.id ??
    null;

  const createHome = async (): Promise<void> => {
    setCreating(true);
    setFailure(null);
    try {
      const outcome = await host.client.action("core.index.createContainer", {
        name: homeName.trim() || "Documents",
        discipline: "text-home",
      });
      if (!outcome.ok) {
        setFailure(outcome.denial.message);
        return;
      }
      const home = ContainerResponseSchema.parse(outcome.result).container;
      setCreatedHome(home);
      setHomeId(home.id);
      setHomeName("");
      refresh();
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : "Could not create the document home");
    } finally {
      setCreating(false);
    }
  };

  return (
    <section className="text-documents" aria-label="Documents">
      <NodeTitleBar
        icon={<ItemIcon kind="text" />}
        title="Documents"
        defaultTitle="Documents"
        extraActions={
          <button
            type="button"
            className="text-documents__button"
            onClick={() => host.navigate("/")}
          >
            Workspace
          </button>
        }
      />
      {!enabled ? (
        <p className="text-documents__message" role="status">
          Text is disabled. Documents are retained and cannot be edited.
        </p>
      ) : (
        <>
          <div className="text-documents__toolbar">
            <label className="text-documents__choice">
              Document home
              <select
                value={selectedHomeId ?? ""}
                onChange={(event) => setHomeId(event.currentTarget.value)}
              >
                {selectedHomeId === null ? (
                  <option value="">
                    {entries === null ? "Loading homes…" : "No accessible homes"}
                  </option>
                ) : null}
                {selectedHomeId !== null && !homes.some((home) => home.id === selectedHomeId) ? (
                  <option value={selectedHomeId}>{selectedHomeId}</option>
                ) : null}
                {homes.map((home) => (
                  <option key={home.id} value={home.id}>
                    {home.name} ({home.discipline})
                  </option>
                ))}
              </select>
            </label>
            <form
              className="text-documents__new-home"
              onSubmit={(event) => {
                event.preventDefault();
                void createHome();
              }}
            >
              <input
                aria-label="New document home name"
                placeholder="New home name"
                maxLength={120}
                value={homeName}
                onChange={(event) => setHomeName(event.currentTarget.value)}
                disabled={creating}
              />
              <button
                type="submit"
                className="text-documents__button"
                data-action="core.index.createContainer"
                disabled={creating}
              >
                {creating ? "Creating…" : "New text home"}
              </button>
            </form>
          </div>
          <p className="text-documents__hint">
            Documents stay in their original home, even after their last visual reference is
            removed. Choose any accessible home to find its retained documents.
          </p>
          {failure !== null || indexFailure !== null ? (
            <p className="text-documents__message" role="alert">
              {failure ?? indexFailure}
            </p>
          ) : null}
          {selectedHomeId !== null ? (
            <DocumentHome key={selectedHomeId} host={host} homeContainerId={selectedHomeId} />
          ) : null}
        </>
      )}
    </section>
  );
}

function DocumentsPanel({ host, arg }: PanelProps): ReactElement {
  if (arg?.["document"] !== undefined) {
    const reference = decodeTextDocument(arg["document"]);
    return reference === null ? (
      <p className="text-documents__message" role="status">
        Invalid document reference
      </p>
    ) : (
      <DocumentPage host={host} reference={reference} />
    );
  }
  return <DocumentBrowser host={host} />;
}

function DocumentsRoute({
  host,
  rest,
}: {
  readonly host: HostServices;
  readonly rest: string;
}): ReactElement {
  if (rest === "")
    return (
      <main className="text-documents-route">
        <DocumentBrowser host={host} />
      </main>
    );
  const reference = decodeTextDocumentRoute(rest);
  return (
    <main className="text-documents-route">
      {reference === null ? (
        <p className="text-documents__message" role="status">
          This document link is invalid.
        </p>
      ) : (
        <DocumentPage host={host} reference={reference} />
      )}
    </main>
  );
}

function TextHome(props: ContainerRendererProps): ReactElement {
  const container = props.containers.find((candidate) => candidate.id === props.containerId);
  return (
    <section className="text-documents" data-container-id={props.containerId}>
      <NodeTitleBar
        icon={<ItemIcon kind="text" />}
        title={container?.name ?? null}
        defaultTitle="Documents"
        dragProps={props.titlebarDragProps}
        middle={props.titlebarMiddle}
        extraActions={props.titlebarExtras}
      />
      {props.host.assembly.enabled(TEXT_NAMESPACE) ? (
        <DocumentHome
          key={props.containerId}
          host={props.host}
          homeContainerId={props.containerId}
          {...(props.client === undefined ? {} : { client: props.client })}
        />
      ) : (
        <p className="text-documents__message" role="status">
          Text is disabled. Documents are retained and cannot be edited.
        </p>
      )}
    </section>
  );
}

function DocumentsSection({ host }: SectionProps): ReactElement {
  return (
    <button
      type="button"
      className="sidebar-new"
      title="Documents"
      aria-label="Documents"
      onClick={() => host.navigate("/text/")}
    >
      <ItemIcon kind="text" />
      <span>Documents</span>
    </button>
  );
}

export const textWeb = {
  id: TEXT_NAMESPACE,
  elements: { text: TextElement },
  panels: { documents: DocumentsPanel },
  routes: { text: DocumentsRoute },
  renderers: { "text-home": TextHome },
  sections: { documents: DocumentsSection },
};
