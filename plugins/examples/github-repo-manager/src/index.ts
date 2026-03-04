import type { PluginScript } from "@playwrong/plugin-sdk";
import type { FunctionCallDef, PluginExtractResult, ScalarValue, SemanticNode } from "@playwrong/protocol";

const HOSTS = ["github.com", "www.github.com"];
const NEW_REPO_URL = "https://github.com/new";
const RECEIPT_VERSION = "llm_webop_v2";

interface InvokeReceiptOptions {
  usedSelector?: string;
  retryable?: boolean;
  suggestedNext?: string;
}

function withInvokeReceipt(
  targetId: string,
  fn: string,
  urlBefore: string,
  data: Record<string, unknown> = {},
  options: InvokeReceiptOptions = {}
): Record<string, unknown> {
  return {
    ...data,
    ok: true,
    contractVersion: RECEIPT_VERSION,
    action: {
      targetId,
      fn
    },
    page: {
      urlBefore,
      urlAfter: window.location.href
    },
    diagnostics: {
      usedSelector: options.usedSelector ?? null
    },
    recovery: {
      retryable: options.retryable ?? true,
      suggestedNext: options.suggestedNext ?? "sync_then_pull"
    }
  };
}

const SELECTORS = {
  newRepoLink: [
    "a[href='/new']",
    "a[data-hydro-click*='new_repository']"
  ],
  repoName: [
    "input#repository_name",
    "input[name='repository[name]']"
  ],
  repoDescription: [
    "input#repository_description",
    "textarea#repository_description",
    "input[name='repository[description]']",
    "textarea[name='repository[description]']"
  ],
  visibilityPublic: [
    "input#repository_visibility_public",
    "input[name='repository[visibility]'][value='public']"
  ],
  visibilityPrivate: [
    "input#repository_visibility_private",
    "input[name='repository[visibility]'][value='private']"
  ],
  autoInit: [
    "input#repository_auto_init",
    "input[name='repository[auto_init]']"
  ],
  createRepoSubmit: [
    "form[action='/repositories'] button[type='submit']",
    "button[data-testid='create-repository-submit-button']",
    "button[data-testid='create-repository-button']",
    "button[type='submit'][data-disable-with*='Creating']"
  ]
} as const;

const PAGE_CALLS: FunctionCallDef[] = [
  { name: "refresh", sideEffect: true },
  { name: "openNewRepository", sideEffect: true },
  {
    name: "createRepository",
    sideEffect: true,
    argsSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        visibility: { enum: ["public", "private"] },
        autoInit: { type: "boolean" }
      },
      required: ["name"]
    }
  },
  {
    name: "debugRepoForm",
    sideEffect: false
  }
];

function normalizeText(input: string | null | undefined): string {
  return (input ?? "").replace(/\s+/g, " ").trim();
}

function isVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) {
    return true;
  }
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function querySelectorAllDeep<T extends Element>(selector: string): T[] {
  const results: T[] = [];
  const visited = new Set<Node>();
  const stack: Array<Document | ShadowRoot> = [document];

  while (stack.length > 0) {
    const root = stack.pop();
    if (!root || visited.has(root)) {
      continue;
    }
    visited.add(root);

    results.push(...Array.from(root.querySelectorAll<T>(selector)));

    const hosts = Array.from(root.querySelectorAll<HTMLElement>("*"));
    for (const host of hosts) {
      const shadow = host.shadowRoot;
      if (shadow && !visited.has(shadow)) {
        stack.push(shadow);
      }
    }
  }

  return results;
}

function findRepositoryForm(): HTMLFormElement | null {
  const direct = firstElement<HTMLFormElement>([
    "form[action='/repositories']",
    "form.js-new-repo-form",
    "form[data-testid='create-repository-form']"
  ]);
  if (direct) {
    return direct;
  }

  const forms = querySelectorAllDeep<HTMLFormElement>("form");
  for (const form of forms) {
    const submit = form.querySelector<HTMLElement>("button[type='submit'], input[type='submit']");
    const submitText = normalizeText(submit?.textContent ?? "");
    if (/create repository|create repo|create/i.test(submitText)) {
      return form;
    }
    if (form.getAttribute("action") === "/repositories") {
      return form;
    }
  }
  return null;
}

function getRepoNameField(): HTMLInputElement | null {
  const direct = firstElement<HTMLInputElement>(SELECTORS.repoName);
  if (direct) {
    return direct;
  }

  const getCandidates = (root: ParentNode): HTMLInputElement[] =>
    Array.from(root.querySelectorAll<HTMLInputElement>("input:not([type='hidden']):not([type='checkbox']):not([type='radio'])"))
      .filter((input) => isVisible(input) && !input.disabled);

  const form = findRepositoryForm();
  const candidates = form ? getCandidates(form) : [];

  const semantic = candidates.find((input) => {
    const key = `${input.id} ${input.name} ${input.placeholder} ${input.getAttribute("aria-label") ?? ""}`.toLowerCase();
    return key.includes("repository") || key.includes("repo") || key.includes("name");
  });
  if (semantic) {
    return semantic;
  }

  const globalCandidates = querySelectorAllDeep<HTMLInputElement>(
    "input:not([type='hidden']):not([type='checkbox']):not([type='radio'])"
  ).filter((input) => isVisible(input) && !input.disabled);

  const globalSemantic = globalCandidates.find((input) => {
    const key = `${input.id} ${input.name} ${input.placeholder} ${input.getAttribute("aria-label") ?? ""}`.toLowerCase();
    return (
      key.includes("repository") ||
      key.includes("repo") ||
      key.includes("name") ||
      key.includes("owner")
    );
  });
  if (globalSemantic) {
    return globalSemantic;
  }

  return candidates[0] ?? globalCandidates[0] ?? null;
}

function getDescriptionField(): HTMLInputElement | HTMLTextAreaElement | null {
  const direct = firstElement<HTMLInputElement | HTMLTextAreaElement>(SELECTORS.repoDescription);
  if (direct) {
    return direct;
  }

  const collectFields = (root: ParentNode): Array<HTMLInputElement | HTMLTextAreaElement> =>
    Array.from(root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("textarea, input[type='text']"))
      .filter((input) => isVisible(input) && !input.disabled);

  const form = findRepositoryForm();
  const fields = form ? collectFields(form) : [];

  const semanticFromForm = fields.find((input) => {
    const key = `${input.id} ${input.name} ${input.placeholder} ${input.getAttribute("aria-label") ?? ""}`.toLowerCase();
    return key.includes("description");
  });
  if (semanticFromForm) {
    return semanticFromForm;
  }

  const globalFields = querySelectorAllDeep<HTMLInputElement | HTMLTextAreaElement>("textarea, input[type='text']")
    .filter((input) => isVisible(input) && !input.disabled);

  return (
    globalFields.find((input) => {
      const key = `${input.id} ${input.name} ${input.placeholder} ${input.getAttribute("aria-label") ?? ""}`.toLowerCase();
      return key.includes("description");
    }) ?? null
  );
}

function firstElement<T extends Element>(selectors: readonly string[]): T | null {
  for (const selector of selectors) {
    const all = querySelectorAllDeep<T>(selector);
    const visible = all.find((item) => isVisible(item));
    if (visible) {
      return visible;
    }
    const fallback = all[0];
    if (fallback) {
      return fallback;
    }
  }
  return null;
}

function dispatchInputEvents(element: HTMLElement): void {
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function toBoolean(value: ScalarValue): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (Array.isArray(value)) {
    const first = value[0] ?? "";
    return normalizeText(first).toLowerCase() === "true";
  }
  return normalizeText(String(value ?? "")).toLowerCase() === "true";
}

function setFieldValue(field: HTMLInputElement | HTMLTextAreaElement, value: ScalarValue): void {
  const next = Array.isArray(value) ? value.join(" ") : String(value ?? "");
  field.value = next;
  dispatchInputEvents(field);
}

function setChecked(field: HTMLInputElement, checked: boolean): void {
  if (field.checked !== checked) {
    field.checked = checked;
    dispatchInputEvents(field);
  }
}

function isOnNewRepoPage(): boolean {
  return window.location.hostname.endsWith("github.com") && window.location.pathname === "/new";
}

function getCurrentRepoFromPath(): { owner: string; repo: string } | null {
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    return null;
  }

  const owner = parts[0] ?? "";
  const repo = parts[1] ?? "";
  if (!owner || !repo) {
    return null;
  }

  const blocked = new Set(["new", "settings", "orgs", "organizations", "marketplace", "features", "explore", "notifications"]);
  if (blocked.has(owner)) {
    return null;
  }

  return { owner, repo };
}

function createCommonActionsNode(): SemanticNode {
  const node: SemanticNode = {
    id: "github.actions",
    kind: "group",
    label: "GitHub Actions",
    children: [
      {
        id: "github.repo.new.open",
        kind: "action",
        label: "Open New Repository",
        value: "Open New Repository",
        calls: [{ name: "click", sideEffect: true }]
      }
    ]
  };

  const link = firstElement<HTMLAnchorElement>(SELECTORS.newRepoLink);
  if (link?.href) {
    const action = node.children?.[0];
    if (action) {
      action.attrs = { href: link.href };
    }
  }

  return node;
}

function createRepoNewTree(): SemanticNode[] {
  const roots: SemanticNode[] = [createCommonActionsNode()];

  const repoNameInput = getRepoNameField();
  if (!repoNameInput) {
    return roots;
  }

  const descriptionInput = getDescriptionField();
  const publicRadio = firstElement<HTMLInputElement>(SELECTORS.visibilityPublic);
  const privateRadio = firstElement<HTMLInputElement>(SELECTORS.visibilityPrivate);
  const autoInit = firstElement<HTMLInputElement>(SELECTORS.autoInit);

  const formChildren: SemanticNode[] = [
    {
      id: "github.repo.new.name",
      kind: "editable",
      label: "Repository Name",
      value: repoNameInput.value,
      calls: [
        { name: "focus", sideEffect: false }
      ]
    }
  ];

  if (descriptionInput) {
    formChildren.push({
      id: "github.repo.new.description",
      kind: "editable",
      label: "Description",
      value: descriptionInput.value,
      calls: [
        { name: "focus", sideEffect: false }
      ]
    });
  }

  if (publicRadio) {
    formChildren.push({
      id: "github.repo.new.visibility.public",
      kind: "toggle",
      label: "Public",
      value: publicRadio.checked,
      calls: [{ name: "click", sideEffect: true }]
    });
  }

  if (privateRadio) {
    formChildren.push({
      id: "github.repo.new.visibility.private",
      kind: "toggle",
      label: "Private",
      value: privateRadio.checked,
      calls: [{ name: "click", sideEffect: true }]
    });
  }

  if (autoInit) {
    formChildren.push({
      id: "github.repo.new.auto_init",
      kind: "toggle",
      label: "Add README",
      value: autoInit.checked,
      calls: [{ name: "click", sideEffect: true }]
    });
  }

  formChildren.push({
    id: "github.repo.new.submit",
    kind: "action",
    label: "Create Repository",
    value: "Create Repository",
    calls: [
      { name: "click", sideEffect: true },
      { name: "submit", sideEffect: true }
    ]
  });

  roots.push({
    id: "github.repo.new.form",
    kind: "form",
    label: "New Repository",
    children: formChildren
  });

  return roots;
}

function createRepoCurrentNode(): SemanticNode | null {
  const repo = getCurrentRepoFromPath();
  if (!repo) {
    return null;
  }

  const slug = `${repo.owner}/${repo.repo}`;
  return {
    id: "github.repo.current",
    kind: "group",
    label: "Current Repository",
    attrs: {
      owner: repo.owner,
      repo: repo.repo,
      slug
    },
    children: [
      {
        id: "github.repo.current.slug",
        kind: "content",
        label: "Repository",
        value: slug
      }
    ]
  };
}

function extractTree(): PluginExtractResult {
  if (window.location.pathname.startsWith("/login")) {
    return {
      pageType: "github.login",
      pageCalls: PAGE_CALLS,
      tree: [
        {
          id: "github.actions",
          kind: "group",
          label: "GitHub Actions",
          children: [
            {
              id: "github.repo.new.open",
              kind: "action",
              label: "Open New Repository",
              value: "Open New Repository",
              calls: [{ name: "click", sideEffect: true }]
            }
          ]
        },
        {
          id: "github.login.notice",
          kind: "content",
          label: "Login Required",
          value: "Please sign in to GitHub before creating a repository."
        }
      ]
    };
  }

  if (isOnNewRepoPage()) {
    return {
      pageType: "github.repo.new",
      pageCalls: PAGE_CALLS,
      tree: createRepoNewTree()
    };
  }

  const tree: SemanticNode[] = [createCommonActionsNode()];
  const currentRepo = createRepoCurrentNode();
  if (currentRepo) {
    tree.push(currentRepo);
  }

  return {
    pageType: "github.page",
    pageCalls: PAGE_CALLS,
    tree
  };
}

function requireElement<T extends Element>(element: T | null): T {
  if (element) {
    return element;
  }
  throw new Error("PLUGIN_MISS");
}

function submitNewRepositoryForm(): void {
  const submit = firstElement<HTMLElement>(SELECTORS.createRepoSubmit);
  if (submit) {
    submit.click();
    return;
  }

  const form = findRepositoryForm();
  if (form) {
    form.requestSubmit();
    return;
  }

  throw new Error("PLUGIN_MISS");
}

function invokeCreateRepository(args: Record<string, unknown> | undefined): { ok: true; name: string } {
  const name = typeof args?.name === "string" ? normalizeText(args.name) : "";
  if (!name) {
    throw new Error("createRepository requires args.name");
  }

  if (!isOnNewRepoPage()) {
    window.location.href = NEW_REPO_URL;
    return { ok: true, name };
  }

  const nameField = requireElement(getRepoNameField());
  setFieldValue(nameField, name);

  if (typeof args?.description === "string") {
    const descriptionField = getDescriptionField();
    if (descriptionField) {
      setFieldValue(descriptionField, args.description);
    }
  }

  const visibility = args?.visibility === "private" ? "private" : "public";
  const publicRadio = firstElement<HTMLInputElement>(SELECTORS.visibilityPublic);
  const privateRadio = firstElement<HTMLInputElement>(SELECTORS.visibilityPrivate);
  if (visibility === "private") {
    if (privateRadio) {
      privateRadio.click();
    }
  } else if (publicRadio) {
    publicRadio.click();
  }

  if (typeof args?.autoInit === "boolean") {
    const autoInit = firstElement<HTMLInputElement>(SELECTORS.autoInit);
    if (autoInit) {
      setChecked(autoInit, args.autoInit);
    }
  }

  submitNewRepositoryForm();
  return { ok: true, name };
}

function invokeDebugRepoForm(): Record<string, unknown> {
  const allInputs = querySelectorAllDeep<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
  const visibleInputs = allInputs.filter((input) => isVisible(input)).slice(0, 40);

  const inputs = visibleInputs.map((input) => ({
    tag: input.tagName.toLowerCase(),
    type: input instanceof HTMLInputElement ? input.type : "textarea",
    id: input.id || "",
    name: input.getAttribute("name") || "",
    placeholder: input.getAttribute("placeholder") || "",
    ariaLabel: input.getAttribute("aria-label") || "",
    valuePreview: (input as HTMLInputElement | HTMLTextAreaElement).value?.slice(0, 80) ?? ""
  }));

  return {
    url: window.location.href,
    pageTitle: document.title,
    isOnNewRepoPage: isOnNewRepoPage(),
    totalInputs: allInputs.length,
    visibleInputs: inputs.length,
    foundRepoName: Boolean(getRepoNameField()),
    foundDescription: Boolean(getDescriptionField()),
    foundForm: Boolean(findRepositoryForm()),
    foundSubmit: Boolean(firstElement<HTMLElement>(SELECTORS.createRepoSubmit)),
    inputs
  };
}

export const pluginScripts: PluginScript[] = [
  {
    scriptId: "example.github.repo-manager.v1",
    priority: 850,
    rules: [{ hosts: HOSTS, scoreBoost: 0.55 }],
    async extract(): Promise<PluginExtractResult> {
      return extractTree();
    },
    async setValue(ctx, value): Promise<void> {
      if (ctx.target.id === "github.repo.new.name") {
        const field = requireElement(getRepoNameField());
        setFieldValue(field, value);
        return;
      }

      if (ctx.target.id === "github.repo.new.description") {
        const field = requireElement(getDescriptionField());
        setFieldValue(field, value);
        return;
      }

      if (ctx.target.id === "github.repo.new.visibility.public") {
        const field = requireElement(firstElement<HTMLInputElement>(SELECTORS.visibilityPublic));
        setChecked(field, toBoolean(value));
        return;
      }

      if (ctx.target.id === "github.repo.new.visibility.private") {
        const field = requireElement(firstElement<HTMLInputElement>(SELECTORS.visibilityPrivate));
        setChecked(field, toBoolean(value));
        return;
      }

      if (ctx.target.id === "github.repo.new.auto_init") {
        const field = requireElement(firstElement<HTMLInputElement>(SELECTORS.autoInit));
        setChecked(field, toBoolean(value));
        return;
      }

      throw new Error("PLUGIN_MISS");
    },
    async invoke(ctx, fn, args): Promise<unknown> {
      const urlBefore = window.location.href;

      if (ctx.target.id === "page" && fn === "refresh") {
        window.location.reload();
        return withInvokeReceipt(ctx.target.id, fn, urlBefore);
      }

      if (ctx.target.id === "page" && fn === "openNewRepository") {
        window.location.href = NEW_REPO_URL;
        return withInvokeReceipt(ctx.target.id, fn, urlBefore, { url: NEW_REPO_URL });
      }

      if (ctx.target.id === "page" && fn === "createRepository") {
        return withInvokeReceipt(ctx.target.id, fn, urlBefore, invokeCreateRepository(args));
      }
      if (ctx.target.id === "page" && fn === "debugRepoForm") {
        return withInvokeReceipt(ctx.target.id, fn, urlBefore, invokeDebugRepoForm(), {
          retryable: false,
          suggestedNext: "none"
        });
      }

      if (ctx.target.id === "github.repo.new.open" && fn === "click") {
        window.location.href = NEW_REPO_URL;
        return withInvokeReceipt(ctx.target.id, fn, urlBefore, { url: NEW_REPO_URL }, { usedSelector: "a[href='/new']" });
      }

      if (ctx.target.id === "github.repo.new.submit" && (fn === "click" || fn === "submit")) {
        submitNewRepositoryForm();
        return withInvokeReceipt(ctx.target.id, fn, urlBefore, {}, { usedSelector: "form[action='/repositories'] button[type='submit']" });
      }

      if (ctx.target.id === "github.repo.new.name" && fn === "focus") {
        const field = requireElement(getRepoNameField());
        field.focus();
        return withInvokeReceipt(ctx.target.id, fn, urlBefore, {}, { usedSelector: "input#repository_name" });
      }

      if (ctx.target.id === "github.repo.new.description" && fn === "focus") {
        const field = requireElement(getDescriptionField());
        field.focus();
        return withInvokeReceipt(ctx.target.id, fn, urlBefore, {}, { usedSelector: "textarea#repository_description" });
      }

      if (ctx.target.id === "github.repo.new.visibility.public" && fn === "click") {
        const field = requireElement(firstElement<HTMLInputElement>(SELECTORS.visibilityPublic));
        field.click();
        return withInvokeReceipt(ctx.target.id, fn, urlBefore, {}, { usedSelector: "input#repository_visibility_public" });
      }

      if (ctx.target.id === "github.repo.new.visibility.private" && fn === "click") {
        const field = requireElement(firstElement<HTMLInputElement>(SELECTORS.visibilityPrivate));
        field.click();
        return withInvokeReceipt(ctx.target.id, fn, urlBefore, {}, { usedSelector: "input#repository_visibility_private" });
      }

      if (ctx.target.id === "github.repo.new.auto_init" && fn === "click") {
        const field = requireElement(firstElement<HTMLInputElement>(SELECTORS.autoInit));
        field.click();
        return withInvokeReceipt(ctx.target.id, fn, urlBefore, {}, { usedSelector: "input#repository_auto_init" });
      }

      throw new Error("PLUGIN_MISS");
    }
  }
];
