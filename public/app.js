(() => {
  "use strict";

  // Every address comes from js/api.js, which reads the startup from the page
  // address (/s/<startupId>/). Without one, js/startups.js shows the screen
  // that creates the first startup and this file does not boot.
  const Api = window.StartupTrackerApi;
  if (!Api) {
    throw new Error("js/api.js must load before app.js");
  }
  const STARTUP_ID = Api.startupId;
  const API_STATE_URL = STARTUP_ID ? Api.api("/state") : "";
  const API_MEDIA_UPLOAD_URL = STARTUP_ID ? Api.api("/media/upload") : "";
  const API_MEDIA_DOCUMENT_URL = STARTUP_ID ? Api.api("/media/document") : "";
  // Search and the calendar show "this" startup or "all" open startups; the
  // choice is remembered per startup.
  const SCOPE_THIS = "this";
  const SCOPE_ALL = "all";
  const SEARCH_SCOPE_STORAGE_KEY = STARTUP_ID ? Api.storageKey("search-scope") : "";
  const CALENDAR_SCOPE_STORAGE_KEY = STARTUP_ID ? Api.storageKey("calendar-scope") : "";
  // Section toggles, event types, status filter and summary range.
  const CALENDAR_FILTERS_STORAGE_KEY = STARTUP_ID ? Api.storageKey("calendar-filters") : "";
  const GLOBAL_SEARCH_DELAY = 200;
  const GLOBAL_SEARCH_LIMIT = 18;
  const GLOBAL_SEARCH_MAX_VALUE_LENGTH = 20000;
  const GLOBAL_SEARCH_IGNORED_KEYS = new Set([
    "id",
    "createdAt",
    "updatedAt",
    "deletedAt",
    "targetId",
    "linkedTargetIds",
    "linkedProgramIds",
    "linkedFundingIds",
    "linkedMediaIds",
    "linkedProgramId",
    "campaignId",
    "roundId",
    "fileUrl",
    "base64",
    "data",
    "mimeType",
    "size",
  ]);

  const defaults = window.StartupTrackerDefaults;
  if (!defaults) {
    throw new Error("Startup Tracker defaults must load before app.js");
  }

  // Date maths and formatting (js/dates.js) and translations (js/i18n.js).
  const Dates = window.StartupTrackerDates;
  const I18n = window.StartupTrackerI18n;
  if (!Dates || !I18n) {
    throw new Error("js/dates.js and js/i18n.js must load before app.js");
  }
  const t = I18n.t;
  // Shared settings (js/settings-store.js), the appearance (taste-switcher.js)
  // and the recycle-bin rules (js/recycle.js).
  const Settings = window.StartupTrackerSettings;
  const Appearance = window.StartupTrackerAppearance;
  const Recycle = window.StartupTrackerRecycle;
  if (!Settings || !Appearance || !Recycle) {
    throw new Error("js/settings-store.js, scripts/taste-switcher.js and js/recycle.js must load before app.js");
  }
  // Data shared by every startup (js/global-data.js) and the shared option
  // lists (js/options.js).
  // The Prompts page (js/prompts-page.js), its renderer and "Import AI results".
  const PromptsPage = window.StartupTrackerPromptsPage;
  const PromptRender = window.StartupTrackerPromptRender;
  const AiImport = window.StartupTrackerAiImport;
  // The Company tab (js/company-model.js, js/company-page.js).
  const CompanyModel = window.StartupTrackerCompany;
  const CompanyPage = window.StartupTrackerCompanyPage;
  // Agent runs (js/agents-page.js).
  const AgentsPage = window.StartupTrackerAgentsPage;
  const GlobalData = window.StartupTrackerGlobalData;
  const Options = window.StartupTrackerOptions;
  const LinkTypes = window.StartupTrackerLinkTypes;
  if (!GlobalData || !Options || !LinkTypes) {
    throw new Error("js/global-data.js, js/options.js and js/link-types.js must load before app.js");
  }

  // The zone every "today" and every shown time is read in: Settings >
  // General, or the browser's own zone when that is left empty.
  function getTimeZone() {
    return Settings.effectiveTimeZone(Settings.get(), Dates.defaultTimeZone());
  }

  // "system", "d MMM yyyy" or "yyyy-MM-dd" (Settings > General).
  function getDateFormat() {
    return Dates.normalizeDateFormat(Settings.get().dateFormat);
  }

  // "monday" or "sunday" (Settings > General).
  function getWeekStart() {
    return Dates.normalizeWeekStart(Settings.get().weekStart);
  }

  // The locale for numbers and dates. Follows the interface language.
  function getLocale() {
    return I18n.getLocale();
  }

  // A number in the app's locale. Text that is not a number is shown as typed.
  function formatNumber(value) {
    const numeric = typeof value === "number" ? value : Number(value);
    if (value === "" || value === null || value === undefined || !Number.isFinite(numeric)) return String(value ?? "");
    return I18n.formatNumber(numeric);
  }

  const {
    DEFAULT_TAG_DEFINITIONS,
    DEFAULT_EXTRA_PARAMS,
    dailyPriorities,
    feedbackStatuses,
    mediaSources,
    MANAGER_PAGE_SIZE,
  } = defaults;


  const PROGRAM_DOCUMENT_STATUSES = ["Unknown", "Not required", "Required", "In progress", "Ready", "Submitted", "Accepted", "Needs changes"];
  const PROGRAM_ACTIVITY_TYPES = [
    { id: "verification", get label() { return t("app.programActivityTypes.verificationResearch"); } },
    { id: "application", get label() { return t("app.programActivityTypes.applicationSubmission"); } },
    { id: "response", get label() { return t("app.programActivityTypes.responseReceived"); } },
    { id: "follow-up", get label() { return t("app.programActivityTypes.followUp"); } },
    { id: "meeting", get label() { return t("app.programActivityTypes.callOrMeeting"); } },
    { id: "published", get label() { return t("app.programActivityTypes.publishedOrLive"); } },
    { id: "milestone", get label() { return t("app.programActivityTypes.milestone"); } },
    { id: "decision", get label() { return t("app.programActivityTypes.decision"); } },
    { id: "reapply", get label() { return t("app.programActivityTypes.reapplyRenewal"); } },
    { id: "other", get label() { return t("app.programActivityTypes.other"); } },
  ];
  const PROGRAM_ACTIVITY_PREVIOUS_ACTION_STATUSES = [
    { id: "completed", get label() { return t("app.programActivityPreviousActionStatuses.completed"); } },
    { id: "deferred", get label() { return t("app.programActivityPreviousActionStatuses.deferred"); } },
    { id: "cancelled", get label() { return t("app.programActivityPreviousActionStatuses.cancelledNoLongerRelevant"); } },
    { id: "still-open", get label() { return t("app.programActivityPreviousActionStatuses.stillOpen"); } },
    { id: "none", get label() { return t("app.programActivityPreviousActionStatuses.noCurrentAction"); } },
  ];

  // The marketing categories this startup has turned on, in the nested shape
  // much of the page reads (refreshTaxonomy fills it from the library).
  let categories = [];
  const Taxonomy = window.StartupTrackerTaxonomy;
  // The field registry (js/fields.js), loaded at boot.
  const Fields = window.StartupTrackerFields;

  // Extra > Categories turned nodes on or off for this startup. The choice is
  // one section, saved through the outbox.
  function setEnabledTaxonomy(selection) {
    state.enabledTaxonomy = selection && Array.isArray(selection.enabled) ? { enabled: [...selection.enabled] } : null;
    refreshTaxonomy();
    markDataChanged();
    persist(t("categories.selectionSaved"));
    render();
  }

  // The shared library changed. Records were repointed on the server when
  // nodes were merged or deleted, so the page reads them again.
  async function taxonomyChanged({ recordsMoved = false } = {}) {
    refreshTaxonomy();
    if (recordsMoved) await loadStateFromServer();
    render();
  }

  // Applies the library and this startup's on/off choice to the page's
  // category lists.
  function refreshTaxonomy() {
    Taxonomy.setEnabled(state.enabledTaxonomy);
    categories = Taxonomy.nestedCategories("mk", { onlyEnabled: true });
    Object.values(taxonomyPickers).forEach((picker) => picker.refresh());
  }

  // The category pickers of the add forms and the record windows.
  const taxonomyPickers = {};

  function initTaxonomyPickers() {
    const Picker = window.StartupTrackerTaxonomyPicker;
    const make = (key, holder, section) => {
      if (holder && Picker) taxonomyPickers[key] = Picker.create(holder, { section, label: t("taxonomy.fieldLabel") });
    };
    make("mkForm", elements.mkFormTaxonomy, "mk");
    make("poForm", elements.programFormTaxonomy, "po");
    make("fuForm", elements.fundingFormTaxonomy, "fu");
  }

  function pickerValue(key) {
    return taxonomyPickers[key]?.getValue() || [];
  }

  function setPickerValue(key, list) {
    taxonomyPickers[key]?.setValue(Array.isArray(list) ? list : []);
  }

  // Stores a picked list on a record, with the older single-value fields
  // mirrored from it.
  function applyTaxonomy(record, list, { subcategories = false } = {}) {
    record.taxonomy = Taxonomy.normalizeSelection(list);
    const fields = Taxonomy.legacyFields(record.taxonomy, record);
    record.category = fields.category;
    record.subcategory = fields.subcategory;
    record.type = fields.type;
    if (subcategories) record.subcategories = fields.subcategories;
    return record;
  }

  // ---- Links between records (js/links-model.js) -----------------------------
  //
  // One "links" collection per startup. A link shows on both ends; links to a
  // record in the recycle bin are kept and hidden until it comes back.

  const Links = window.StartupTrackerLinks;
  const ItemPicker = window.StartupTrackerItemPicker;
  const RECORD_KINDS = ["mk", "po", "fu", "media", "feedback", "campaign", "research"];
  // What a media item can be used in: any other kind of record.
  const MEDIA_USED_IN_KINDS = RECORD_KINDS.filter((kind) => kind !== "media");

  function liveCollectionOfKind(kind) {
    if (kind === "mk") return state.items;
    if (kind === "po") return state.programs;
    if (kind === "fu") return state.funding;
    if (kind === "media") return state.mediaItems;
    if (kind === "feedback") return state.feedbackItems;
    if (kind === "campaign") return state.campaigns;
    if (kind === "research") return state.dailyLinks;
    if (kind === "comp") return state.companySteps;
    if (kind === "expense") return state.companyExpenses;
    return [];
  }

  function findRecordOfKind(kind, id) {
    return (liveCollectionOfKind(kind) || []).find((record) => String(record.id) === String(id)) || null;
  }

  function recordTitle(kind, record) {
    if (!record) return "";
    if (kind === "mk") return record.platform || record.id;
    if (kind === "po") return record.name || record.applicationName || record.id;
    if (kind === "fu") return record.funder || record.opportunity || record.id;
    return record.title || record.name || record.url || record.id;
  }

  // What the pickers and link lists show for a record: title, section colour,
  // status badge and a second line (category and date).
  function describeRecord(ref) {
    const record = findRecordOfKind(ref.kind, ref.id);
    if (!record) return null;
    const section = ["mk", "po", "fu"].includes(ref.kind) ? ref.kind : "";
    const kindLabel = Sections.byId(section)?.short || ItemPicker.KIND_LABELS[ref.kind] || ref.kind;
    let subtitle = "";
    let statusHtml = "";
    if (section) {
      const primary = Taxonomy.leaves(record.taxonomy)[0];
      const date = ref.kind === "mk" ? record.date : record.nextActionDate;
      subtitle = [primary ? Taxonomy.pathLabel(primary) : "", date ? formatDate(date) : ""].filter(Boolean).join(" · ");
      statusHtml = record.status ? statusBadgeHtml(record.status) : "";
    } else if (ref.kind === "media") {
      subtitle = [record.type, record.sourceType].filter(Boolean).join(" · ");
    } else if (ref.kind === "feedback") {
      subtitle = [record.type, record.status].filter(Boolean).join(" · ");
    } else if (ref.kind === "campaign") {
      subtitle = [Statuses.campaignStatusLabel(record.status), formatDateRange(record.startDate, record.endDate)].filter(Boolean).join(" · ");
    } else if (ref.kind === "research") {
      subtitle = record.url || "";
    }
    return { kind: ref.kind, id: String(record.id), title: recordTitle(ref.kind, record), subtitle, statusHtml, section, kindLabel, updatedAt: record.updatedAt || "" };
  }

  // Records for an ItemPicker: every word typed must appear in the title or
  // the second line. With nothing typed, the most recently changed come first.
  function pickerSource(query, { kinds, limit }) {
    const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    const matches = [];
    for (const kind of kinds) {
      for (const record of liveCollectionOfKind(kind) || []) {
        const item = describeRecord({ kind, id: record.id });
        if (!item) continue;
        if (words.length) {
          const text = `${item.title} ${item.subtitle}`.toLowerCase();
          if (!words.every((word) => text.includes(word))) continue;
        }
        matches.push(item);
      }
    }
    if (!words.length) matches.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    // Grouped by kind in the order asked, keeping each kind's order.
    const order = new Map(kinds.map((kind, index) => [kind, index]));
    matches.sort((a, b) => order.get(a.kind) - order.get(b.kind));
    return { items: matches.slice(0, limit), total: matches.length };
  }

  function createItemPicker(holder, options) {
    return ItemPicker.create(holder, { source: pickerSource, describe: describeRecord, ...options });
  }

  // The visible links of a record: those whose other end is not in the bin.
  function visibleLinksOf(kind, id) {
    return Links.linksOf(state.links, kind, String(id), { isVisible: (other) => Boolean(findRecordOfKind(other.kind, other.id)) });
  }

  function linkedRefs(kind, id, relation, side) {
    return visibleLinksOf(kind, id)
      .filter((entry) => entry.link.relation === relation && (!side || entry.side === side))
      .map((entry) => entry.other);
  }

  // Replaces a record's links of one relation with links to `refs`. Links to
  // records in the bin are left alone.
  function setLinkedRefs(kind, id, relation, side, refs) {
    const hidden = Links.linksOf(state.links, kind, String(id))
      .filter((entry) => entry.link.relation === relation && (!side || entry.side === side || relation === "related") && !findRecordOfKind(entry.other.kind, entry.other.id))
      .map((entry) => entry.other);
    state.links = Links.setOthers(state.links, { kind, id: String(id) }, relation, side || "a", [...refs, ...hidden]);
    markDataChanged();
  }

  // The linked records' titles, for search.
  function linkedText(kind, id) {
    return visibleLinksOf(kind, id).map((entry) => describeRecord(entry.other)?.title || "").join(" ");
  }

  // Pills for a table row: "Label: Title", each opening the other record.
  function linkPillsHtml(kind, id, { relations = null } = {}) {
    return visibleLinksOf(kind, id)
      .filter((entry) => !relations || relations.includes(entry.link.relation))
      .map((entry) => {
        const item = describeRecord(entry.other);
        if (!item) return "";
        return `<button class="tag-pill link-pill" type="button" data-link-open="${escapeAttribute(`${entry.other.kind}:${entry.other.id}`)}"${item.section ? ` data-section="${item.section}"` : ""}>${escapeHtml(entry.label)}: ${escapeHtml(item.title)}</button>`;
      })
      .join("");
  }

  // Opens a linked record in its own window or list.
  function openLinkedRecord(ref) {
    if (ref.kind === "mk") {
      const item = findItem(ref.id);
      if (item) openNotesModal(item);
    } else if (ref.kind === "po") openProgramModal(ref.id);
    else if (ref.kind === "fu") openFundingModal(ref.id);
    else if (ref.kind === "media") openMediaForEditing(ref.id);
    else openGlobalSearchResult({ type: ref.kind === "research" ? "daily-link" : ref.kind, id: ref.id, matchKind: "" });
  }

  // The Links panel of a record window: every link, grouped by its name, and
  // a picker to add more, with the relation to use.
  function renderLinksPanel(container, kind, id, { onChange = () => {} } = {}) {
    if (!container) return;
    if (!id) {
      container.innerHTML = `<p class="empty-text">${escapeHtml(t("links.saveFirst"))}</p>`;
      return;
    }
    const entries = visibleLinksOf(kind, id);
    const groups = new Map();
    for (const entry of entries) {
      if (!groups.has(entry.label)) groups.set(entry.label, []);
      groups.get(entry.label).push(entry);
    }
    const relationOptions = Object.keys(Links.RELATIONS).map((relation) => `<option value="${relation}">${escapeHtml(t(`links.relations.${relation}`))}</option>`).join("");
    container.innerHTML = `
      <div class="links-panel">
        ${entries.length ? [...groups].map(([label, list]) => `
          <section class="links-group">
            <h5>${escapeHtml(label)}</h5>
            <ul>
              ${list.map((entry) => {
                const item = describeRecord(entry.other);
                return `<li class="links-row"${item.section ? ` data-section="${item.section}"` : ""}>
                  ${item.section ? `<span class="section-dot" aria-hidden="true"></span>` : ""}
                  <span class="links-kind">${escapeHtml(item.kindLabel)}</span>
                  <button type="button" class="links-open" data-link-open="${escapeAttribute(`${entry.other.kind}:${entry.other.id}`)}">${escapeHtml(item.title)}</button>
                  ${item.statusHtml}
                  ${entry.link.context ? `<span class="links-context">${escapeHtml(entry.link.context)}</span>` : ""}
                  <button type="button" class="icon-button links-remove" data-link-remove="${escapeAttribute(entry.link.id)}" aria-label="${escapeAttribute(t("links.remove", { name: item.title }))}">×</button>
                </li>`;
              }).join("")}
            </ul>
          </section>`).join("") : `<p class="empty-text">${escapeHtml(t("links.none"))}</p>`}
        <div class="links-add">
          <label class="links-relation"><span>${escapeHtml(t("links.relation"))}</span><select data-link-relation>${relationOptions}</select></label>
          <div class="links-picker" data-link-picker></div>
        </div>
      </div>`;
    const relationSelect = container.querySelector("[data-link-relation]");
    const picker = createItemPicker(container.querySelector("[data-link-picker]"), {
      multiple: false,
      kinds: RECORD_KINDS,
      label: t("links.add"),
      placeholder: t("links.addPlaceholder"),
      recentName: "links",
      onChange: (value) => {
        const other = value[0];
        if (!other || (other.kind === kind && other.id === String(id))) return;
        const relation = relationSelect.value;
        // "Uses" points from the record that uses to the media it uses.
        const link = relation === "uses" && kind === "media"
          ? Links.makeLink(other, { kind, id: String(id) }, relation)
          : Links.makeLink({ kind, id: String(id) }, other, relation);
        state.links = Links.mergeLinks(state.links, [link]);
        markDataChanged();
        persist(t("links.added"));
        onChange();
        renderLinksPanel(container, kind, id, { onChange });
      },
    });
    container.querySelectorAll("[data-link-remove]").forEach((button) => {
      button.addEventListener("click", () => {
        state.links = state.links.filter((link) => link.id !== button.dataset.linkRemove);
        markDataChanged();
        persist(t("links.removed"));
        onChange();
        renderLinksPanel(container, kind, id, { onChange });
      });
    });
    return picker;
  }


  // Tag definitions give each tag an optional best-practice description that
  // surfaces as a hover tooltip wherever the tag pill is shown. Tags themselves
  // remain free-form lowercase strings on items; a definition is matched by its
  // lowercased `id`. Tags without a definition simply have no tooltip.
  let tagDefinitions = [];

  function getTagDefinition(tag) {
    const key = String(tag || "").trim().toLowerCase();
    if (!key) return null;
    return tagDefinitions.find((def) => def.id === key) || null;
  }

  function formatTagTooltip(def) {
    return `
      <div class="tooltip-title">#${escapeHtml(def.label || def.id)}</div>
      <div class="tooltip-section">
        <div class="tooltip-heading">${escapeHtml(t("app.formatTagTooltip.whyThisTagBestPractice"))}</div>
        <div class="tooltip-body">${escapeHtml(def.description || t("app.formatTagTooltip.noDescription"))}</div>
      </div>
    `;
  }

  function tagTooltipAttrs(tag) {
    const def = getTagDefinition(tag);
    if (!def) return "";
    return ` data-tooltip-type="tag" data-tag-id="${escapeAttribute(def.id)}"`;
  }

  // Extra parameters are an editable, configurable schema of optional key/value fields
  // that can be attached to any tracker item. They are grouped, each has guidance
  // (description, examples, suggested defaults), and they are filterable as key:value.
  let extraParamsDefinition = JSON.parse(JSON.stringify(DEFAULT_EXTRA_PARAMS));
  // Extra parameters that became something else: media links, and a
  // target's "Blocked by" / "Blocks", are links now (js/links-model.js).
  // Funding keeps its own "Blocked by" and "Blocks" text fields.
  const RETIRED_EXTRA_PARAM_IDS = new Set(["assets", "linkedMedia"]);
  const RETIRED_TARGET_EXTRA_PARAM_IDS = new Set([...RETIRED_EXTRA_PARAM_IDS, "blockedBy", "blocks"]);

  // The shared status list (public/js/status-model.js) and its filter.
  const Statuses = window.StartupTrackerStatuses;
  const StatusFilter = window.StartupTrackerStatusFilter;
  // The four sections (js/sections.js) and the calendar's events, month
  // grid and summary (js/calendar-model.js).
  const Sections = window.StartupTrackerSections;
  const Calendar = window.StartupTrackerCalendar;

  // A filter as a set. One that was never set starts at Planned and In
  // progress, plus unmapped values.
  function statusSelection(list) {
    return Array.isArray(list) ? new Set(list) : Statuses.defaultSelection();
  }

  // A target's status as a badge coloured by its group. An unknown value
  // shows as it is, with a dashed border and "Unmapped" in its tooltip.
  function statusBadgeHtml(status) {
    const help = Statuses.isKnown(status) ? Statuses.description(status) : t("statusFilter.unmappedHelp");
    return `<span class="${Statuses.badgeClass(status)}" title="${escapeAttribute(help)}">${escapeHtml(getStatusLabel(status))}</span>`;
  }

  function campaignStatusOptions(selected) {
    const known = Statuses.campaignStatuses();
    const unknown = selected && !known.some((status) => status.id === selected)
      ? `<option value="${escapeAttribute(selected)}" selected>${escapeHtml(selected)}</option>`
      : "";
    return unknown + known.map((status) => `<option value="${escapeAttribute(status.id)}" ${status.id === selected ? "selected" : ""}>${escapeHtml(status.label)}</option>`).join("");
  }

  function defaultCampaignStatus() {
    return Statuses.campaignStatuses()[0]?.id || "planned";
  }

  function restoreStatusFilter(list) {
    return Array.isArray(list) ? [...Statuses.restoreSelection(list)] : [...Statuses.defaultSelection()];
  }
  const TRACKER_UI_STATE_KEYS = new Set([
    "focusStatuses",
    "focusPageSize",
    "programFocusPageSize",
    "fundingFocusPageSize",
  ]);
  // Links read from old record fields on load, still to be saved
  // (applyLoadedState, applyPendingLinkMigration).
  let pendingLinkMigration = null;

  // Campaigns, tags and the AI page are shared by every startup and saved
  // through js/global-data.js instead (see collectGlobalSections).
  const PATCHABLE_RECORD_COLLECTIONS = [
    "links",
    "categories",
    "extraParamsDefinition",
    "dailyLinks",
    "feedbackItems",
    "programs",
    "funding",
    "fundingRounds",
    "deletedPrograms",
    "deletedFunding",
    "mediaItems",
    "items",
    "deletedItems",
    "deletedMediaItems",
    "deletedFeedbackItems",
    "deletedDailyLinks",
    "companySteps",
    "companyObligations",
    "companyDeadlines",
    "companyExpenses",
    "deletedCompanySteps",
    "deletedCompanyObligations",
    "deletedCompanyExpenses",
  ];
  // The Company tab's record sections (js/company-model.js).
  const COMPANY_RECORD_SECTIONS = [
    "companySteps",
    "companyObligations",
    "companyDeadlines",
    "companyExpenses",
    "deletedCompanySteps",
    "deletedCompanyObligations",
    "deletedCompanyExpenses",
  ];

  const priorityOrder = {
    "Very High": 0,
    High: 1,
    Medium: 2,
    Low: 3,
    "Very Low": 4,
  };

  const markdownCache = new Map();
  const formattedDateCache = new Map();
  const formattedTimestampCache = new Map();
  const formattedShortTimestampCache = new Map();
  const dateWeightCache = new Map();

  const state = {
    items: [],
    deletedItems: [],
    campaigns: [],
    dailyLinks: [],
    aiAccounts: [],
    aiFlow: [],
    // The AI page's dollar to leu rate (shared, edited on the page).
    aiSettings: { usdToRon: 4.55, rateUpdatedAt: "" },
    // Which shared defaults were added once already ({ tags: <when> }).
    globalSeeded: {},
    editingAiFlowIds: new Set(),
    isEditingAllAiFlow: false,
    feedbackItems: [],
    mediaItems: [],
    programs: [],
    funding: [],
    fundingRounds: [],
    deletedPrograms: [],
    deletedFunding: [],
    // Recycle-bin sections of the record types that used to be deleted for
    // good (js/recycle.js names them; lib/recycle-bin.js purges them).
    deletedCampaigns: [],
    deletedMediaItems: [],
    deletedFeedbackItems: [],
    deletedDailyLinks: [],
    deletedPrompts: [],
    deletedTags: [],
    // The startup profile (Settings > Startup profile), one object.
    profile: null,
    // A startup's older category list (kept, unused) and its on/off choice of
    // library categories.
    legacyCategories: null,
    enabledTaxonomy: null,
    // Links between records (js/links-model.js).
    links: [],
    // The Company tab (js/company-model.js): the profile, then the records.
    companyProfile: null,
    companySteps: [],
    companyObligations: [],
    companyDeadlines: [],
    companyExpenses: [],
    deletedCompanySteps: [],
    deletedCompanyObligations: [],
    deletedCompanyExpenses: [],
    selectedOcSubTab: "ai",
    selectedExtraSubTab: "ai",
    // Your prompts, presets and examples (shared; js/prompts-page.js).
    prompts: [],
    promptPresets: [],
    promptExamples: [],
    selectedAppTab: "calendar",
    globalSearchQuery: "",
    globalSearchOpen: false,
    globalSearchExpanded: false,
    formLinkedProgramIds: [],
    selectedCategory: "all",
    selectedSubcategory: "all",
    selectedMkType: "all",
    search: "",
    statusFilter: "all",
    priorityFilter: "all",
    campaignFilter: "all",
    // Programs filters/pages
    selectedProgramCategory: "all",
    selectedProgramStatus: "all",
    selectedProgramPriority: "all",
    selectedProgramType: "all",
    selectedProgramNodeType: "all",
    selectedProgramCampaign: "all",
    programQuickFilter: "all",
    programSearch: "",
    programPage: 1,
    programPageSize: 10,
    programSortColumn: null,
    programSortDirection: null,
    programExtraParamFilter: [],
    programTagFilter: [],
    programFormNotes: "",
    programFormTags: [],
    programFormExtraParams: {},
    programFormLinkedTargetIds: [],
    programFormPanelCollapsed: true,
    programTablePanelCollapsed: false,
    // Programs date-mode focus queue
    programFocusDate: todayDate(),
    programFocusDateMode: "on",
    programFocusPage: 1,
    programFocusPageSize: 6,
    // Status filters hold status ids; null means the default (Planned and
    // In progress), worked out once the status list has loaded.
    programFocusStatuses: null,
    programFocusPanelCollapsed: false,
    // Calendar view state
    isInitialLoading: true,
    isSyncing: false,
    calendarCenterDate: todayDate(),
    calendarSelectedDate: todayDate(),
    calendarDateMode: "on",
    calendarStatusFilter: null,
    calendarMonthOpen: false,
    // The first day of the month the month panel shows.
    calendarMonthAnchor: null,
    // Read from storage at boot (readCalendarFilters).
    calendarSections: new Set(["mk", "po", "fu", "comp"]),
    calendarKinds: new Set(["next_action", "deadline", "milestone", "payment", "company"]),
    calendarSummaryRange: "range",
    // Funding filters/pages
    selectedFundingCategory: "all",
    selectedFundingType: "all",
    selectedFundingNodeType: "all",
    selectedFundingStatus: "all",
    selectedFundingPriority: "all",
    selectedFundingCampaign: "all",
    selectedFundingPreset: "all",
    fundingSearch: "",
    fundingPage: 1,
    fundingPageSize: 10,
    fundingSortColumn: null,
    fundingSortDirection: null,
    fundingExtraParamFilter: [],
    fundingTagFilter: [],
    fundingFormNotes: "",
    fundingFormTags: [],
    fundingFormExtraParams: {},
    fundingFormLinkedTargetIds: [],
    fundingFormLinkedProgramId: "",
    fundingFormPanelCollapsed: true,
    fundingRoundsPanelCollapsed: false,
    fundingTablePanelCollapsed: false,
    selectedFundingRound: "all",
    // Funding date-mode focus queue
    fundingFocusDate: todayDate(),
    fundingFocusDateMode: "on",
    fundingFocusPage: 1,
    fundingFocusPageSize: 6,
    fundingFocusStatuses: null,
    fundingFocusPanelCollapsed: false,
    // Editing states
    tempProgramMilestones: [],
    tempQuickFundingCommitments: [],
    mediaDocumentItemId: null,
    mediaDocumentOriginalText: "",
    mediaDocumentLoading: false,
    mediaDocumentRequestId: 0,
    focusStatuses: null,
    focusDate: todayDate(),
    focusDateMode: "on",
    focusPage: 1,
    focusPageSize: 6,
    // Tags + extra parameters
    tagFilter: [],
    extraParamFilter: [],
    pipelinePresetFilter: "all",
    formNotes: "",
    formTags: [],
    formExtraParams: {},
    sortColumn: null,
    sortDirection: null,
    mediaSearch: "",
    mediaTypeFilter: "all",
    mediaSourceFilter: "all",
    mediaTargetFilter: "all",
    mediaKindFilter: "all",
    mediaTagFilter: "all",
    aiSearch: "",
    copyingMediaId: null,
    feedbackSearch: "",
    dailySearch: "",
    editingCampaignId: null,
    editingDailyLinkId: null,
    editingAiAccountId: null,
    editingFeedbackItemId: null,
    editingMediaItemId: null,
    editingTagId: null,
    highlightedTargetId: null,
    expandedLinkedTargetSections: [],
    focusPanelCollapsed: false,
    lastServerFileHash: "",
    lastServerRevision: 0,
    lastPersistedContentSignature: "",
    inFlightContentSignature: null,
    conflictState: false,
    // Records the server rejected because someone else changed that exact
    // record. Unlike conflictState this never blocks editing.
    recordConflicts: [],
    formPanelCollapsed: true,
    tablePanelCollapsed: false,
    campaignSearch: "",
    campaignStatusFilter: ["planned", "active"],
    campaignTagFilter: [],
    campaignTargetStatusFilter: [],
    campaignTargetPriorityFilter: [],
    campaignPage: 1,
    tagSearch: "",
    tagUsageFilter: "all",
    tagPage: 1,
    mediaPage: 1,
    feedbackPage: 1,
    feedbackTagFilter: [],
    feedbackTypeFilter: "all",
    feedbackStageFilter: "all",
    feedbackEvidenceFilter: "all",
    currentPage: 1,
    pageSize: 10,
    apiReady: false,
    filePath: "",
    mediaDir: "",
    // "this" startup or "all" startups, remembered per startup.
    searchScope: readStoredScope(SEARCH_SCOPE_STORAGE_KEY),
    calendarScope: readStoredScope(CALENDAR_SCOPE_STORAGE_KEY),
    allSearch: { query: "", results: [], truncated: false, loading: false, failed: false },
    allCalendar: { events: [], records: [], loadedAt: 0, loading: false, failed: false },
  };

  let autosaveTimer = null;

  // Data-backed render caches. Most UI state changes only affect controls or
  // pagination; these caches are invalidated whenever persisted data changes,
  // keeping repeated renders from rebuilding the same indexes and derived
  // collections while preserving current render behavior.
  let derivedDataRevision = 0;
  let idIndexCache = new WeakMap();
  let pipelineFilterCache = null;
  let mediaFilterCache = null;
  let tagRecordsCache = null;
  let globalSearchCache = null;
  let calendarEventsCache = null;
  let programMilestoneCache = new WeakMap();
  let programQueueCache = new WeakMap();
  let fundingQueueCache = new WeakMap();

  function markDataChanged() {
    derivedDataRevision += 1;
    idIndexCache = new WeakMap();
    pipelineFilterCache = null;
    mediaFilterCache = null;
    tagRecordsCache = null;
    globalSearchCache = null;
    calendarEventsCache = null;
    programMilestoneCache = new WeakMap();
    programQueueCache = new WeakMap();
    fundingQueueCache = new WeakMap();
  }

  function getIdIndex(records) {
    if (!Array.isArray(records)) return new Map();
    const cached = idIndexCache.get(records);
    if (cached && cached.length === records.length) return cached.index;

    const index = new Map();
    records.forEach((record) => {
      if (record && record.id !== undefined && record.id !== null) {
        index.set(record.id, record);
      }
    });
    idIndexCache.set(records, { length: records.length, index });
    return index;
  }

  const elements = {
    appTabs: document.querySelector("#appTabs"),
    appViews: document.querySelectorAll("[data-app-view]"),
    categoryTabs: document.querySelector("#categoryTabs"),
    subcategoryTabs: document.querySelector("#subcategoryTabs"),
    mkTypeTabs: document.querySelector("#mkTypeTabs"),
    // Holders of the category pickers (js/taxonomy-picker.js).
    mkFormTaxonomy: document.querySelector("#mkFormTaxonomy"),
    programFormTaxonomy: document.querySelector("#programFormTaxonomy"),
    fundingFormTaxonomy: document.querySelector("#fundingFormTaxonomy"),
    focusList: document.querySelector("#focusList"),
    focusDateModeBtns: document.querySelectorAll("#focusDateBar .focus-date-mode-btn"),
    form: document.querySelector("#taskForm"),
    projectLinksDropdown: document.querySelector("#projectLinksDropdown"),
    projectLinksToggle: document.querySelector("#projectLinksToggle"),
    projectLinksMenu: document.querySelector("#projectLinksMenu"),
    themeToggleButton: document.querySelector("#themeToggleButton"),
    settingsPanel: document.querySelector("#settingsPanel"),
    globalSearch: document.querySelector("#globalSearch"),
    globalSearchToggle: document.querySelector("#globalSearchToggle"),
    globalSearchInput: document.querySelector("#globalSearchInput"),
    globalSearchResults: document.querySelector("#globalSearchResults"),
    globalSearchList: document.querySelector("#globalSearchList"),
    searchScopeButtons: document.querySelectorAll("[data-search-scope]"),
    calendarScopeButtons: document.querySelectorAll("[data-calendar-scope]"),
    calendarScopeStatus: document.querySelector("#calendarScopeStatus"),
    breadcrumbView: document.querySelector("#breadcrumbView"),
    taskRows: document.querySelector("#taskRows"),
    saveStateLabel: document.querySelector("#saveStateLabel"),
    recordConflictModal: document.querySelector("#recordConflictModal"),
    recordConflictReview: document.querySelector("#recordConflictReview"),
    closeRecordConflictModal: document.querySelector("#closeRecordConflictModal"),
    cancelRecordConflictModal: document.querySelector("#cancelRecordConflictModal"),
    useTheirsConflictButton: document.querySelector("#useTheirsConflictButton"),
    keepMineConflictButton: document.querySelector("#keepMineConflictButton"),
    historyPreviewModal: document.querySelector("#historyPreviewModal"),
    historyPreviewModalField: document.querySelector("#historyPreviewModalField"),
    historyPreviewModalBody: document.querySelector("#historyPreviewModalBody"),
    closeHistoryPreviewModal: document.querySelector("#closeHistoryPreviewModal"),
    historyRestoreModal: document.querySelector("#historyRestoreModal"),
    historyRestoreModalField: document.querySelector("#historyRestoreModalField"),
    historyRestoreModalBody: document.querySelector("#historyRestoreModalBody"),
    closeHistoryRestoreModal: document.querySelector("#closeHistoryRestoreModal"),
    cancelHistoryRestoreModal: document.querySelector("#cancelHistoryRestoreModal"),
    confirmHistoryRestoreModal: document.querySelector("#confirmHistoryRestoreModal"),
    // Extra parameters + tags
    mediaDocumentModal: document.querySelector("#mediaDocumentModal"),
    closeMediaDocumentModal: document.querySelector("#closeMediaDocumentModal"),
    cancelMediaDocumentModal: document.querySelector("#cancelMediaDocumentModal"),
    saveMediaDocumentModal: document.querySelector("#saveMediaDocumentModal"),
    mediaDocumentModalTitle: document.querySelector("#mediaDocumentModalTitle"),
    mediaDocumentPath: document.querySelector("#mediaDocumentPath"),
    mediaDocumentTabs: document.querySelector("#mediaDocumentTabs"),
    mediaDocumentInput: document.querySelector("#mediaDocumentInput"),
    mediaDocumentPreview: document.querySelector("#mediaDocumentPreview"),
    calendarView: document.querySelector("#calendarView"),
    calendarDaysStrip: document.querySelector("#calendarDaysStrip"),
    calendarStripViewport: document.querySelector("#calendarStripViewport"),
    calendarDaysTrack: document.querySelector("#calendarDaysTrack"),
    calendarPrevWeek: document.querySelector("#calendarPrevWeek"),
    calendarNextWeek: document.querySelector("#calendarNextWeek"),
    calendarPrevDay: document.querySelector("#calendarPrevDay"),
    calendarNextDay: document.querySelector("#calendarNextDay"),
    calendarModeButtons: document.querySelectorAll("[data-calendar-mode]"),
    calendarTodayBtn: document.querySelector("#calendarTodayBtn"),
    calendarFilterBar: document.querySelector("#calendarFilterBar"),
    calendarToggles: document.querySelector("#calendarToggles"),
    calendarMonthToggle: document.querySelector("#calendarMonthToggle"),
    calendarMonthPanel: document.querySelector("#calendarMonthPanel"),
    calendarMonthGrid: document.querySelector("#calendarMonthGrid"),
    calendarMonthTitle: document.querySelector("#calendarMonthTitle"),
    calendarMonthPrevMonth: document.querySelector("#calendarMonthPrevMonth"),
    calendarMonthNextMonth: document.querySelector("#calendarMonthNextMonth"),
    calendarDetailTitle: document.querySelector("#calendarDetailTitle"),
    calendarDetailSections: document.querySelector(".calendar-detail-sections"),
    calListMarketing: document.querySelector("#calListMarketing"),
    calListPrograms: document.querySelector("#calListPrograms"),
    calListFunding: document.querySelector("#calListFunding"),
    calListCompany: document.querySelector("#calListCompany"),
    calListCampaigns: document.querySelector("#calListCampaigns"),
    calendarSummaryContainer: document.querySelector("#calendarSummaryContainer"),
    campaignForm: document.querySelector("#campaignForm"),
    campaignNameInput: document.querySelector("#campaignNameInput"),
    campaignStatusInput: document.querySelector("#campaignStatusInput"),
    campaignStartInput: document.querySelector("#campaignStartInput"),
    campaignEndInput: document.querySelector("#campaignEndInput"),
    campaignGoalInput: document.querySelector("#campaignGoalInput"),
    campaignHypothesisInput: document.querySelector("#campaignHypothesisInput"),
    campaignSuccessMetricInput: document.querySelector("#campaignSuccessMetricInput"),
    campaignDescriptionInput: document.querySelector("#campaignDescriptionInput"),
    resetCampaignFormButton: document.querySelector("#resetCampaignFormButton"),
    campaignSearchInput: document.querySelector("#campaignSearchInput"),
    campaignStatusFilters: document.querySelector("#campaignStatusFilters"),
    campaignFacetTagsInput: document.querySelector("#campaignFacetTagsInput"),
    campaignFacetTagsList: document.querySelector("#campaignFacetTagsList"),
    campaignList: document.querySelector("#campaignList"),
    campaignPagination: document.querySelector("#campaignPagination"),
    tagForm: document.querySelector("#tagForm"),
    tagLabelInput: document.querySelector("#tagLabelInput"),
    tagDescriptionInput: document.querySelector("#tagDescriptionInput"),
    resetTagFormButton: document.querySelector("#resetTagFormButton"),
    tagSearchInput: document.querySelector("#tagSearchInput"),
    tagColorInput: document.querySelector("#tagColorInput"),
    tagUsageFilter: document.querySelector("#tagUsageFilter"),
    tagList: document.querySelector("#tagList"),
    tagPagination: document.querySelector("#tagPagination"),
    dailyForm: document.querySelector("#dailyForm"),
    dailySubcategoryInput: document.querySelector("#dailySubcategoryInput"),
    dailyTitleInput: document.querySelector("#dailyTitleInput"),
    dailyUrlInput: document.querySelector("#dailyUrlInput"),
    dailyPriorityInput: document.querySelector("#dailyPriorityInput"),
    dailyActiveInput: document.querySelector("#dailyActiveInput"),
    dailySharedInput: document.querySelector("#dailySharedInput"),
    dailyDescriptionInput: document.querySelector("#dailyDescriptionInput"),
    resetDailyFormButton: document.querySelector("#resetDailyFormButton"),
    dailyGroups: document.querySelector("#dailyGroups"),
    aiGroups: document.querySelector("#aiGroups"),
    aiRate: document.querySelector("#aiRate"),
    aiSearchInput: document.querySelector("#aiSearchInput"),
    feedbackSearchInput: document.querySelector("#feedbackSearchInput"),
    dailySearchInput: document.querySelector("#dailySearchInput"),
    extraView: document.querySelector("#extraView"),
    aiAccountCount: document.querySelector("#aiAccountCount"),
    aiFlowWrap: document.querySelector("#aiFlowWrap"),

    feedbackForm: document.querySelector("#feedbackForm"),
    feedbackTypeInput: document.querySelector("#feedbackTypeInput"),
    feedbackStatusInput: document.querySelector("#feedbackStatusInput"),
    feedbackSourceInput: document.querySelector("#feedbackSourceInput"),
    feedbackAudienceInput: document.querySelector("#feedbackAudienceInput"),
    feedbackContactInput: document.querySelector("#feedbackContactInput"),
    feedbackRelationshipInput: document.querySelector("#feedbackRelationshipInput"),
    feedbackStageInput: document.querySelector("#feedbackStageInput"),
    feedbackAreaInput: document.querySelector("#feedbackAreaInput"),
    feedbackEvidenceInput: document.querySelector("#feedbackEvidenceInput"),
    feedbackTitleInput: document.querySelector("#feedbackTitleInput"),
    feedbackLinkInput: document.querySelector("#feedbackLinkInput"),
    feedbackOpenLinkBtn: document.querySelector("#feedbackOpenLinkBtn"),
    feedbackAboutInput: document.querySelector("#feedbackAboutInput"),
    feedbackDescriptionInput: document.querySelector("#feedbackDescriptionInput"),
    feedbackOutcomeInput: document.querySelector("#feedbackOutcomeInput"),
    feedbackActionInput: document.querySelector("#feedbackActionInput"),
    feedbackBlockFields: document.querySelector("#feedbackBlockFields"),
    resetFeedbackFormButton: document.querySelector("#resetFeedbackFormButton"),
    feedbackList: document.querySelector("#feedbackList"),
    feedbackTypeFilter: document.querySelector("#feedbackTypeFilter"),
    feedbackStageFilter: document.querySelector("#feedbackStageFilter"),
    feedbackEvidenceFilter: document.querySelector("#feedbackEvidenceFilter"),
    feedbackFacetTagsInput: document.querySelector("#feedbackFacetTagsInput"),
    feedbackFacetTagsList: document.querySelector("#feedbackFacetTagsList"),
    feedbackPagination: document.querySelector("#feedbackPagination"),
    feedbackTotalCount: document.querySelector("#feedbackTotalCount"),
    feedbackNeedsReviewCount: document.querySelector("#feedbackNeedsReviewCount"),
    feedbackWorkflowCount: document.querySelector("#feedbackWorkflowCount"),
    feedbackBlockerCount: document.querySelector("#feedbackBlockerCount"),
    mediaForm: document.querySelector("#mediaForm"),
    mediaSourceInput: document.querySelector("#mediaSourceInput"),
    mediaTypeInput: document.querySelector("#mediaTypeInput"),
    mediaFileLabel: document.querySelector("#mediaFileLabel"),
    mediaFileInput: document.querySelector("#mediaFileInput"),
    mediaPathLabel: document.querySelector("#mediaPathLabel"),
    mediaPathInput: document.querySelector("#mediaPathInput"),
    mediaTitleInput: document.querySelector("#mediaTitleInput"),
    mediaTagsInput: document.querySelector("#mediaTagsInput"),
    mediaTagList: document.querySelector("#mediaTagList"),
    mediaNotesInput: document.querySelector("#mediaNotesInput"),
    mediaTargetsInput: document.querySelector("#mediaTargetsInput"),
    resetMediaFormButton: document.querySelector("#resetMediaFormButton"),
    mediaSearchInput: document.querySelector("#mediaSearchInput"),
    mediaTypeFilter: document.querySelector("#mediaTypeFilter"),
    mediaSourceFilter: document.querySelector("#mediaSourceFilter"),
    mediaTargetFilter: document.querySelector("#mediaTargetFilter"),
    mediaTargetFilterMode: document.querySelector("#mediaTargetFilterMode"),
    mediaKindFilter: document.querySelector("#mediaKindFilter"),
    mediaTagFilter: document.querySelector("#mediaTagFilter"),
    mediaList: document.querySelector("#mediaList"),
    mediaPagination: document.querySelector("#mediaPagination"),

    // Programs & Opportunities elements
    programForm: document.querySelector("#programForm"),
    programCategoryTabs: document.querySelector("#programCategoryTabs"),
    programTypeTabs: document.querySelector("#programTypeTabs"),
    programNodeTypeTabs: document.querySelector("#programNodeTypeTabs"),
    programRows: document.querySelector("#programRows"),

    // Funding Pipeline elements
    fundingForm: document.querySelector("#fundingForm"),
    fundingRoundForm: document.querySelector("#fundingRoundForm"),
    fundingRoundNameInput: document.querySelector("#fundingRoundNameInput"),
    fundingRoundStageInput: document.querySelector("#fundingRoundStageInput"),
    fundingRoundTargetInput: document.querySelector("#fundingRoundTargetInput"),
    fundingRoundCurrencyInput: document.querySelector("#fundingRoundCurrencyInput"),
    fundingRoundMinimumInput: document.querySelector("#fundingRoundMinimumInput"),
    fundingRoundCloseInput: document.querySelector("#fundingRoundCloseInput"),
    fundingRoundList: document.querySelector("#fundingRoundList"),
    fundingCategoryTabs: document.querySelector("#fundingCategoryTabs"),
    fundingTypeTabs: document.querySelector("#fundingTypeTabs"),
    fundingNodeTypeTabs: document.querySelector("#fundingNodeTypeTabs"),
    fundingRoundsPanelToggle: document.querySelector("#fundingRoundsPanelToggle"),
    fundingRoundsPanelBody: document.querySelector("#fundingRoundsPanelBody"),
    fundingRows: document.querySelector("#fundingRows"),

    // Shared manager notes & parameters modal

    // Program Modal elements
    // Eligibility inputs
    // Value / Costs inputs
    // Tracking inputs
    // Document checkboxes

    // Program update modal

    // Funding Modal elements
  };

  // Browser storage is per startup: its own IndexedDB database (cached state
  // and outbox) and prefixed localStorage keys. The tab id lives in
  // sessionStorage and only names this tab's records inside that database.
  const CACHE_STORAGE_KEY = STARTUP_ID ? Api.storageKey("cached-state") : "";
  const CACHE_FILE_HASH_STORAGE_KEY = STARTUP_ID ? Api.storageKey("cached-state-file-hash") : "";
  const CACHE_DB_NAME = STARTUP_ID ? Api.cacheDbName(STARTUP_ID) : "";
  const CACHE_DB_VERSION = Api.CACHE_DB_VERSION;
  const CACHE_STORE_NAME = Api.CACHE_STORE_NAME;
  const LEGACY_CACHE_RECORD_KEY = "current";
  const CACHE_TAB_ID_KEY = Api.globalStorageKey("tab-id");
  const LEGACY_CACHE_CLAIM_KEY = STARTUP_ID ? Api.storageKey("legacy-cache-owner") : "";
  const THEME_STORAGE_KEY = Api.globalStorageKey("theme");
  const cacheTabId = (() => {
    try {
      const existing = sessionStorage.getItem(CACHE_TAB_ID_KEY);
      if (existing) return existing;
      const created = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
      sessionStorage.setItem(CACHE_TAB_ID_KEY, created);
      return created;
    } catch (error) {
      return `${Date.now()}-${Math.random()}`;
    }
  })();
  const CACHE_SYNC_KEY = `sync:${cacheTabId}`;
  const CACHE_RECORD_KEY = `current:${cacheTabId}`;
  const LEGACY_CACHE_SYNC_KEY = "sync";
  let cacheWriteQueue = Promise.resolve();
  let localCacheAvailable = true;

  function openStateCacheDb() {
    return new Promise((resolve, reject) => {
      if (!globalThis.indexedDB || !CACHE_DB_NAME) {
        reject(new Error("IndexedDB is unavailable"));
        return;
      }

      const request = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(CACHE_STORE_NAME)) {
          db.createObjectStore(CACHE_STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open the state cache"));
    });
  }

  // The cache database is opened once and kept open. Reopening and closing it
  // per save cost more than the write itself, and holding the handle lets a put
  // start synchronously, which is what makes the clone-free path below safe.
  let cacheDbHandle = null;
  let cacheDbPromise = null;

  function getStateCacheDb() {
    if (cacheDbHandle) return cacheDbHandle;
    if (!cacheDbPromise) {
      cacheDbPromise = openStateCacheDb()
        .then((db) => {
          cacheDbHandle = db;
          // A version change from another tab invalidates this handle.
          db.onversionchange = () => {
            db.close();
            cacheDbHandle = null;
            cacheDbPromise = null;
          };
          db.onclose = () => {
            cacheDbHandle = null;
            cacheDbPromise = null;
          };
          return db;
        })
        .catch((error) => {
          cacheDbPromise = null;
          throw error;
        });
    }
    return cacheDbPromise;
  }

  function putStateCacheRecords(db, entries) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(CACHE_STORE_NAME, "readwrite");
      const store = transaction.objectStore(CACHE_STORE_NAME);
      entries.forEach(([key, value]) => store.put(value, key));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("Could not update the state cache"));
      transaction.onabort = () => reject(transaction.error || new Error("State cache update was aborted"));
    });
  }

  function writeStateCacheRecords(entries) {
    // IndexedDB structured-clones each value when put() is called. Calling it
    // synchronously here means nothing can mutate the values in between, so the
    // caller does not have to clone the state defensively first.
    if (cacheDbHandle) {
      try {
        return putStateCacheRecords(cacheDbHandle, entries);
      } catch (error) {
        cacheDbHandle = null;
        cacheDbPromise = null;
      }
    }
    return Promise.resolve(getStateCacheDb()).then((db) => putStateCacheRecords(db, entries));
  }

  // The cache is split in two so an acknowledgement does not rewrite the whole
  // state. `current` holds the big tracker state and is written only when the
  // content actually changed; `sync` holds the small bookkeeping record (server
  // revision, outbox, acknowledged state) and is written on every save.
  function saveStateToLocalCache(
    trackerState,
    serializedState = null,
    fileHash = null,
    revision = null,
    outbox = [],
    acknowledgedState = null,
    options = {},
  ) {
    if (!trackerState) return cacheWriteQueue;
    // The put below runs synchronously whenever the database handle is already
    // open, so IndexedDB takes its structured-clone snapshot before anything
    // can mutate these objects and no defensive clone is needed. Only the very
    // first write (handle still opening) has to copy, and at that point the
    // state has just been loaded and nothing is editing it.
    const needsDefensiveCopy = !cacheDbHandle;
    const copy = (value) => (needsDefensiveCopy && value ? clonePersistedState(value) : value);
    const activeOutbox = Array.isArray(outbox) ? outbox : [];

    const syncRecord = {
      fileHash: fileHash === null ? state.lastServerFileHash || "" : fileHash || "",
      revision: revision === null ? state.lastServerRevision || 0 : Number(revision) || 0,
      // Small (operations only) and mutated right after a successful send, so
      // this one is always copied.
      outbox: clonePersistedState(activeOutbox),
      acknowledgedState: activeOutbox.length ? copy(acknowledgedState || acknowledgedPersistedState) : null,
      revisionMap: clonePersistedState(serverRevisionMap),
      savedAt: new Date().toISOString(),
    };

    const entries = [[CACHE_SYNC_KEY, syncRecord]];
    if (options.stateUnchanged !== true) {
      const stateRecord = { state: serializedState ? JSON.parse(serializedState) : copy(trackerState) };
      entries.push([CACHE_RECORD_KEY, stateRecord]);
      // A clean state is safe to share as the quick starting point for a new
      // tab. Dirty state stays under this tab's key with its matching outbox.
      if (activeOutbox.length === 0) entries.push([LEGACY_CACHE_RECORD_KEY, stateRecord]);
    }

    // IndexedDB runs transactions against one store in creation order, so
    // starting the write now preserves ordering without chaining onto the
    // previous write's completion.
    cacheWriteQueue = writeStateCacheRecords(entries)
      .then(() => {
        localCacheAvailable = true;
        localStorage.removeItem(CACHE_STORAGE_KEY);
        localStorage.removeItem(CACHE_FILE_HASH_STORAGE_KEY);
      })
      .catch((error) => {
        localCacheAvailable = false;
        throw error;
      });
    return cacheWriteQueue;
  }

  async function readIndexedStateCache() {
    const db = await getStateCacheDb();
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(CACHE_STORE_NAME, "readonly");
      const store = transaction.objectStore(CACHE_STORE_NAME);
      const stateRequest = store.get(CACHE_RECORD_KEY);
      const legacyStateRequest = store.get(LEGACY_CACHE_RECORD_KEY);
      const syncRequest = store.get(CACHE_SYNC_KEY);
      const legacySyncRequest = store.get(LEGACY_CACHE_SYNC_KEY);
      transaction.oncomplete = () => resolve({
        stateRecord: stateRequest.result || legacyStateRequest.result || null,
        syncRecord: syncRequest.result || null,
        legacySyncRecord: legacySyncRequest.result || null,
      });
      transaction.onerror = () => reject(transaction.error || new Error("Could not read the state cache"));
      transaction.onabort = () => reject(transaction.error || new Error("State cache read was aborted"));
    });
  }

  // Each tab keeps its cache under its own key so a dirty tab cannot hand its
  // outbox to another one. Those keys are per session, so without a sweep every
  // app open would leave another multi-megabyte state record behind forever and
  // eventually exhaust the browser's storage quota.
  //
  // A tab whose last write had an empty outbox had nothing unsynced, so its
  // cache is redundant and safe to drop even if that tab is still open -- it
  // simply rewrites it on its next save. Caches with pending work are kept.
  async function pruneStaleTabCaches() {
    try {
      const db = await getStateCacheDb();
      const keys = await new Promise((resolve, reject) => {
        const transaction = db.transaction(CACHE_STORE_NAME, "readonly");
        const request = transaction.objectStore(CACHE_STORE_NAME).getAllKeys();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error || new Error("Could not list the state cache"));
      });

      const otherTabIds = keys
        .filter((key) => typeof key === "string" && key.startsWith("sync:"))
        .map((key) => key.slice("sync:".length))
        .filter((tabId) => tabId && tabId !== cacheTabId);
      if (otherTabIds.length === 0) return;

      const removable = [];
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(CACHE_STORE_NAME, "readonly");
        const store = transaction.objectStore(CACHE_STORE_NAME);
        otherTabIds.forEach((tabId) => {
          const request = store.get(`sync:${tabId}`);
          request.onsuccess = () => {
            const record = request.result;
            const outbox = Array.isArray(record?.outbox) ? record.outbox : [];
            if (outbox.length === 0) removable.push(tabId);
          };
        });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error("Could not read the state cache"));
        transaction.onabort = () => reject(transaction.error || new Error("State cache read was aborted"));
      });
      if (removable.length === 0) return;

      await new Promise((resolve, reject) => {
        const transaction = db.transaction(CACHE_STORE_NAME, "readwrite");
        const store = transaction.objectStore(CACHE_STORE_NAME);
        removable.forEach((tabId) => {
          store.delete(`sync:${tabId}`);
          store.delete(`current:${tabId}`);
        });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error("Could not prune the state cache"));
        transaction.onabort = () => reject(transaction.error || new Error("State cache prune was aborted"));
      });
    } catch (error) {
      // A cache that cannot be pruned is not worth failing a page load over.
    }
  }

  async function loadStateFromLocalCache() {
    try {
      const { stateRecord, syncRecord, legacySyncRecord } = await readIndexedStateCache();
      if (stateRecord?.state && Array.isArray(stateRecord.state.items)) {
        // Caches written before the record split kept the sync fields on the
        // state record itself, so fall back to those when `sync` is absent.
        let sync = syncRecord;
        if (!sync && legacySyncRecord) {
          try {
            const owner = localStorage.getItem(LEGACY_CACHE_CLAIM_KEY);
            if (!owner || owner === cacheTabId) {
              localStorage.setItem(LEGACY_CACHE_CLAIM_KEY, cacheTabId);
              sync = legacySyncRecord;
            }
          } catch (error) {
            // Without a safe one-tab claim, do not copy a possibly dirty
            // legacy outbox into several tabs.
          }
        }
        sync ||= stateRecord;
        return {
          state: stateRecord.state,
          fileHash: sync.fileHash || "",
          revision: Number(sync.revision) || 0,
          outbox: Array.isArray(sync.outbox) ? sync.outbox : [],
          acknowledgedState: sync.acknowledgedState || null,
          revisionMap: sync.revisionMap || null,
        };
      }
    } catch (e) {
      // Fall through to the one-time localStorage migration.
    }

    try {
      const raw = localStorage.getItem(CACHE_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.items)) return null;
      const migrated = {
        state: parsed,
        fileHash: localStorage.getItem(CACHE_FILE_HASH_STORAGE_KEY) || "",
        revision: 0,
        outbox: [],
        acknowledgedState: parsed,
        revisionMap: null,
      };
      await saveStateToLocalCache(migrated.state, raw, migrated.fileHash, 0, [], parsed);
      return migrated;
    } catch (e) {
      return null;
    }
  }

  function updateLoadingUI(isLoading, message = t("app.updateLoadingUi.loadingData")) {
    if (isLoading) {
      markSyncing(message);
    }
    let appBanner = document.querySelector("#appLoadingBanner");
    const mainEl = document.querySelector("main");
    if (!appBanner && mainEl) {
      const appTabs = mainEl.querySelector("#appTabs");
      if (appTabs) {
        appBanner = document.createElement("div");
        appBanner.id = "appLoadingBanner";
        appBanner.className = "app-loading-banner";
        appBanner.innerHTML = `<div class="app-loading-spinner"></div><span id="appLoadingText">${escapeHtml(message)}</span>`;
        mainEl.insertBefore(appBanner, appTabs);
      }
    } else if (appBanner) {
      const txt = appBanner.querySelector("#appLoadingText");
      if (txt) txt.textContent = message;
    }
    if (appBanner) {
      appBanner.style.display = isLoading ? "flex" : "none";
    }
  }

  function initModalScrollLockObserver() {
    function syncBodyScrollLock() {
      const isAnyModalOpen = !!(
        document.querySelector(".modal-overlay.open") ||
        document.querySelector(".config-drawer.open")
      );
      document.body.classList.toggle("modal-open", isAnyModalOpen);
    }

    try {
      const observer = new MutationObserver(syncBodyScrollLock);
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ["class"],
        subtree: true
      });
    } catch (err) {
      // Fallback if MutationObserver is unavailable
    }

    syncBodyScrollLock();
  }

  // The modal tab rows have to stay on one line. They used to wrap, so a row
  // that outgrew its modal (adding the History tab is what pushed the Programs
  // row over) moved onto a second line and shoved the pane below it down. The
  // row now scales instead: the font, the horizontal padding and the gap all
  // come off a single --tab-fit multiplier that this measures and sets.
  const TAB_FIT_ROW_SELECTOR = ".notes-editor-tabs";
  // Below about this the labels stop being readable, so a row that still does not
  // fit scrolls sideways rather than shrinking further. It takes a very narrow
  // window to get there.
  const TAB_FIT_MIN_SCALE = 0.62;

  function measureTabRowContent(row) {
    // Not scrollWidth: that never reports less than clientWidth, so a row with
    // room to spare measures the same as one that fits exactly, and the loop
    // below would shrink a two-tab row that was never too wide to begin with.
    // Adding the tabs up gives the width they really take.
    const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
    let total = gap * Math.max(0, row.childElementCount - 1);
    // offsetWidth rather than a bounding rect: a closed modal card sits at
    // scale(0.95) and rects come back scaled with it, while clientWidth is a
    // layout number that does not. Measuring the two against each other read the
    // Programs row 5% narrower than it lays out, so it was left just fitting and
    // then overflowed the moment the modal opened at full size, which is what cut
    // the History tab in half.
    for (const child of row.children) total += child.offsetWidth;
    return total;
  }

  function fitTabRowToOneLine(row) {
    if (!row) return;
    // Measure at full size every time rather than shrinking from wherever the
    // row already is. Scaling relative to the current size only ever ratchets
    // down, so a row squeezed in a narrow window would stay squeezed after the
    // window widened again.
    row.style.setProperty("--tab-fit", "1");
    // A closed modal reports zero width, and a scale derived from that would be
    // nonsense. The observer calls back with a real width once it opens.
    const available = row.clientWidth;
    if (available <= 0) return;
    // offsetWidth rounds to whole pixels, so a row of tabs can measure a little
    // under what it really takes. A pixel per tab covers the rounding.
    const target = available - Math.min(row.childElementCount, 8);
    if (target <= 0) return;

    // Measured with every tab as bold as the selected one. The active tab is the
    // heavier of the two weights, so fitting the row to its widest state means
    // selecting a different tab cannot tip it into overflowing. Taken off again
    // below, within the same task, so none of it is ever painted.
    row.classList.add("tab-fit-measuring");
    let scale = 1;
    // Each pass lands short of the mark, because borders keep their width while
    // everything else shrinks, so the row needs a little less than the ratio
    // suggests. That is the safe direction to be wrong in: it approaches the
    // right scale from above instead of overshooting into text smaller than it
    // needs to be. Two passes are usually enough.
    try {
      for (let pass = 0; pass < 5; pass += 1) {
        const needed = measureTabRowContent(row);
        if (needed <= target) break;
        scale = Math.max(TAB_FIT_MIN_SCALE, scale * (target / needed));
        row.style.setProperty("--tab-fit", scale.toFixed(3));
        if (scale <= TAB_FIT_MIN_SCALE) break;
      }
    } finally {
      row.classList.remove("tab-fit-measuring");
    }
  }

  function initTabRowFitter() {
    const rows = [...document.querySelectorAll(TAB_FIT_ROW_SELECTOR)];
    if (rows.length === 0) return;

    const pending = new Set();
    function scheduleFit(row) {
      if (!row || pending.has(row)) return;
      pending.add(row);
      // Off the frame, so a row that is opened and clicked in the same tick is
      // measured once, against the layout it actually ends up with.
      requestAnimationFrame(() => {
        pending.delete(row);
        fitTabRowToOneLine(row);
      });
    }

    try {
      const lastWidth = new WeakMap();
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const width = entry.contentRect.width;
          // Only a width change can affect whether the row fits. Ignoring the
          // rest matters: shrinking the font can shorten the row, which would
          // otherwise report back as a resize and start the measuring again.
          if (lastWidth.get(entry.target) === width) continue;
          lastWidth.set(entry.target, width);
          scheduleFit(entry.target);
        }
      });
      // Watching the rows covers both cases at once: a modal opening takes its
      // row from zero to full width, and resizing the window changes it again.
      for (const row of rows) observer.observe(row);
    } catch (err) {
      window.addEventListener("resize", () => rows.forEach(scheduleFit));
    }

    // Activating a tab makes it bold, which changes the row's content width
    // without changing the row's own box, so the observer sees nothing.
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!target || typeof target.closest !== "function") return;
      const row = target.closest(TAB_FIT_ROW_SELECTOR);
      if (row) scheduleFit(row);
    }, true);

    // A closed overlay is still laid out, only invisible, so its tab row already
    // has its full width and the resize observer has nothing to report when the
    // modal opens. Two things can change at that moment: the record decides which
    // tab starts out selected, and filling the panes can bring up the modal
    // body's scrollbar, which takes width off the row.
    const overlays = new Set();
    for (const row of rows) {
      const overlay = row.closest(".modal-overlay");
      if (overlay) overlays.add(overlay);
    }
    if (overlays.size) {
      const overlayObserver = new MutationObserver((records) => {
        for (const record of records) {
          if (!record.target.classList.contains("open")) continue;
          for (const row of record.target.querySelectorAll(TAB_FIT_ROW_SELECTOR)) {
            scheduleFit(row);
          }
        }
      });
      for (const overlay of overlays) {
        overlayObserver.observe(overlay, { attributes: true, attributeFilter: ["class"] });
      }
    }

    // A fit measured against a fallback font is measured against the wrong
    // letter widths.
    if (document.fonts && typeof document.fonts.ready?.then === "function") {
      document.fonts.ready.then(() => rows.forEach(scheduleFit)).catch(() => {});
    }

    rows.forEach(scheduleFit);
  }

  async function boot() {
    // A page without a startup shows the create screen (js/startups.js).
    if (!STARTUP_ID) return;
    // Strings must be in place before the first render. ready never rejects; a
    // failed load leaves the English text written in the markup.
    await I18n.ready;
    initModalScrollLockObserver();
    initTabRowFitter();
    // The shared status list feeds every dropdown, badge and filter. It falls
    // back to the shipped list when the server cannot answer.
    await Statuses.load();
    // The shared category library, before any record is read.
    await Taxonomy.load();
    // The field registry and the custom fields the target window draws.
    await Fields.load();
    // The shared option lists, and the shared data: campaigns, tags, the AI
    // page and shared research links.
    await loadOptionLists();
    await loadGlobalData();
    configureRecordWindow();
    initSectionPages();
    readCalendarFilters();
    // What js/startups.js and js/settings.js reach of this page: the leave
    // hook, the startup profile and the recycle bin, both saved through the
    // outbox like every other edit.
    window.StartupTrackerPage = Object.freeze({
      prepareToLeave,
      getProfile,
      saveProfile,
      getRecycleBin,
      restoreFromBin,
      deleteFromBin,
      emptyBin,
      applyStatusList,
      setEnabledTaxonomy,
      taxonomyChanged,
    });
    // Labels of this startup's own entries in the combined views use its name.
    window.addEventListener("startup-tracker:startup", () => {
      combinedCalendarCache = null;
      if (state.calendarScope === SCOPE_ALL) renderCalendarTab();
    });
    populateStaticControls();
    bindEvents();
    bindDelegatedActions();
    bindExtraHeaders();
    applyDefaultPageSize(Settings.get().pageSize);
    Settings.subscribe(applySettingsToPage);
    // The top bar's light/dark button follows the appearance, whichever
    // control changed it.
    Appearance.subscribe((appearance) => updateTheme(appearance.resolved));

    // Initialize theme from storage
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY) || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    updateTheme(savedTheme);

    const cachedState = await loadStateFromLocalCache();
    // Drop other sessions' finished caches once this tab has read its own.
    pruneStaleTabCaches();
    if (cachedState) {
      state.isInitialLoading = false;
      state.isSyncing = true;
      state.lastServerFileHash = cachedState.fileHash;
      state.lastServerRevision = cachedState.revision;
      pendingOutbox = Array.isArray(cachedState.outbox) ? cachedState.outbox : [];
      acceptServerRevisionMap(cachedState.revisionMap);
      state.recordConflicts = pendingOutbox
        .filter((batch) => batch.blockedByConflict)
        .flatMap((batch) => Array.isArray(batch.conflicts) ? batch.conflicts : []);
      applyLoadedState(cachedState.state);
      const cachedPersistedState = buildPersistedState();
      let acknowledgedState = cachedState.acknowledgedState || cachedPersistedState;
      if (!cachedState.acknowledgedState) {
        [...pendingOutbox].reverse().forEach((batch) => {
          acknowledgedState = applyOperationsToPersistedState(
            acknowledgedState,
            batch.rollbackOperations || [],
            batch.baseUpdatedAt || acknowledgedState.updatedAt,
          );
        });
      }
      acceptAcknowledgedPersistedState(acknowledgedState);
      render();
      applyPanelCollapseState();
      updateLoadingUI(false);
      markSyncing(t("app.boot.syncingData"));
    } else {
      state.isInitialLoading = true;
      state.isSyncing = true;
      render();
      updateLoadingUI(true, t("app.boot.loadingData"));
      markSyncing(t("app.boot.loadingData"));
    }

    // The sidebar badge counts runs going and runs waiting for you.
    agentRunCounts = AgentsPage?.watchCounts({ Api }, updateAgentBadge) || null;
    // /s/<id>/agents/<runId> shows one run in its own window.
    const ownWindowRun = Api.parseRunId(window.location.pathname);
    if (ownWindowRun) {
      document.documentElement.setAttribute("data-run-window", "");
      state.selectedAppTab = "agents";
      renderAppTabs();
      agentsPage()?.openRun(ownWindowRun);
    }

    try {
      await loadStateFromServer();
    } finally {
      state.isInitialLoading = false;
      state.isSyncing = false;
      updateLoadingUI(false);
      render();
      applyPanelCollapseState();
    }
    openRecordFromAddress();
  }

  function populateStaticControls() {
    initTaxonomyPickers();
    populateStatusControls();
    updateMediaSourceMode();
  }

  function populateStatusControls() {
    elements.campaignStatusInput.innerHTML = campaignStatusOptions(defaultCampaignStatus());
  }

  // Settings › Statuses saved a new list. When records moved to another
  // status, the page reads them again from the server.
  async function applyStatusList(config, { recordsMoved = false } = {}) {
    Statuses.setConfig(config);
    populateStatusControls();
    calendarEventsCache = null;
    combinedCalendarCache = null;
    if (recordsMoved) await loadStateFromServer();
    render();
  }

  function formatCompactAmount(amount, currency = "EUR") {
    const numeric = Number(amount) || 0;
    const maximumFractionDigits = numeric >= 100000 ? 0 : 1;
    const compact = I18n.formatNumber(numeric, { notation: "compact", maximumFractionDigits });
    const prefix = currency === "EUR" ? "€" : `${currency} `;
    return `${prefix}${compact}`;
  }

  function getProgramCategoryLabel(categoryValue) {
    return categoryValue ? Taxonomy.name(categoryValue) : t("app.getProgramCategoryLabel.uncategorized");
  }

  // The program's subcategory, and its type when it has one.
  function getProgramTypeLabel(program) {
    const parts = [program?.subcategory, program?.type].filter(Boolean).map((id) => Taxonomy.name(id));
    return parts.join(" > ") || t("app.getProgramTypeLabel.unspecified");
  }

  function getProgramActivityTypeLabel(type) {
    return PROGRAM_ACTIVITY_TYPES.find((entry) => entry.id === type)?.label || t("app.getProgramActivityTypeLabel.otherType");
  }

  function getProgramPreviousActionStatusLabel(status) {
    return PROGRAM_ACTIVITY_PREVIOUS_ACTION_STATUSES.find((entry) => entry.id === status)?.label || t("app.getProgramPreviousActionStatus.noCurrentAction");
  }

  function getProgramActivityTimestamp(entry) {
    if (entry?.date && /^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
      const value = dateWeight(entry.date, entry.time || "00:00");
      if (value !== Number.MAX_SAFE_INTEGER) return value;
    }
    const fallback = new Date(entry?.loggedAt || entry?.createdAt || 0).getTime();
    return Number.isFinite(fallback) ? fallback : 0;
  }

  function getProgramMilestone(program) {
    const today = todayDate();
    const cached = programMilestoneCache.get(program);
    if (cached && cached.revision === derivedDataRevision && cached.today === today) {
      return cached.value;
    }

    const milestones = Array.isArray(program.timeEntries) ? program.timeEntries.slice() : [];
    if (!milestones.length) {
      programMilestoneCache.set(program, { revision: derivedDataRevision, today, value: null });
      return null;
    }
    milestones.sort((a, b) => dateWeight(a.date, a.time) - dateWeight(b.date, b.time));
    const todayWeight = startOfToday().getTime();
    const value = milestones.find((entry) => dateWeight(entry.date, entry.time) >= todayWeight)
      || milestones[milestones.length - 1];
    programMilestoneCache.set(program, { revision: derivedDataRevision, today, value });
    return value;
  }

  function getProgramQueueEntry(program) {
    const today = todayDate();
    const cached = programQueueCache.get(program);
    if (cached && cached.revision === derivedDataRevision && cached.today === today) {
      return cached.value;
    }

    const details = program.details || {};
    const timelineCandidates = [];
    const milestone = getProgramMilestone(program);

    if (program.nextActionDate) {
      timelineCandidates.push({
        date: program.nextActionDate,
        time: program.nextActionTime || "",
        label: program.nextAction || details.nextAction || t("ui.common.nextAction"),
        detail: program.owner || details.internalOwner || details.actionOwner || details.blocker || "",
        canonical: true,
      });
    }
    if (!program.nextActionDate && details.actionDeadline) {
      timelineCandidates.push({
        date: details.actionDeadline,
        time: "",
        label: program.nextAction || details.nextAction || t("app.getProgramQueueEntry.nextActionDue"),
        detail: program.owner || details.actionOwner || details.blocker || "",
      });
    }
    const submittedOn = details.submittedOn || details.submissionDate;
    if (submittedOn) {
      timelineCandidates.push({
        date: submittedOn,
        time: "",
        label: t("app.getProgramQueueEntry.submissionTarget"),
        detail: program.applicationName || program.subcategory || "",
      });
    }
    const interviewOn = String(details.interviewOn || details.interviewDate || "").slice(0, 10);
    if (interviewOn) {
      timelineCandidates.push({
        date: interviewOn,
        time: "",
        label: t("app.getProgramQueueEntry.interview"),
        detail: program.applicationName || "",
      });
    }
    if (details.pitchDate) {
      timelineCandidates.push({
        date: details.pitchDate,
        time: "",
        label: t("app.getProgramQueueEntry.pitch"),
        detail: program.applicationName || "",
      });
    }
    if (milestone) {
      timelineCandidates.push({
        date: milestone.date,
        time: milestone.time || "",
        label: milestone.label || t("app.getProgramQueueEntry.milestone"),
        detail: "",
      });
    }

    timelineCandidates.sort((a, b) => dateWeight(a.date, a.time) - dateWeight(b.date, b.time));

    const todayWeight = startOfToday().getTime();
    const chosenTimeline = timelineCandidates.find((entry) => entry.canonical)
      || timelineCandidates.find((entry) => dateWeight(entry.date, entry.time) >= todayWeight)
      || (timelineCandidates.length > 0 ? timelineCandidates[timelineCandidates.length - 1] : null);
    const summary = details.blocker
      ? t("app.getProgramQueueEntry.blocked", { blocker: details.blocker })
      : program.nextAction || details.nextAction || chosenTimeline?.detail || program.applicationName || program.subcategory || t("app.getProgramQueueEntry.reviewFitAndRequirements");

    const value = {
      id: program.id,
      title: program.name,
      status: program.status,
      priority: program.priority,
      actionLabel: chosenTimeline?.label || t("app.getProgramQueueEntry.reviewOpportunity"),
      summary,
      date: chosenTimeline?.date || "",
      time: chosenTimeline?.time || "",
      link: program.applicationLink || "",
      updatedAt: program.updatedAt || "",
    };
    programQueueCache.set(program, { revision: derivedDataRevision, today, value });
    return value;
  }

  function summarizeMoney(entries, predicate = null) {
    const list = Array.isArray(entries)
      ? entries.filter((entry) => {
          if (!entry || !(Number(entry.amount) > 0)) return false;
          return predicate ? predicate(entry) : true;
        })
      : [];
    if (!list.length) {
      return { count: 0, amount: 0, currency: "EUR", display: "€0", mixed: false };
    }

    const currencies = Array.from(new Set(list.map((entry) => String(entry.currency || "EUR").trim().toUpperCase() || "EUR")));
    const amount = list.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
    if (currencies.length === 1) {
      return {
        count: list.length,
        amount,
        currency: currencies[0],
        display: formatCompactAmount(amount, currencies[0]),
        mixed: false,
      };
    }

    const totals = currencies.map((currency) => ({
      currency,
      amount: list
        .filter((entry) => String(entry.currency || "EUR").trim().toUpperCase() === currency)
        .reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0),
    }));
    return {
      count: list.length,
      amount,
      currency: "",
      display: totals.map((total) => formatCompactAmount(total.amount, total.currency)).join(" · "),
      mixed: true,
    };
  }

  function getFundingQueueEntry(funding) {
    const cached = fundingQueueCache.get(funding);
    if (cached && cached.revision === derivedDataRevision) return cached.value;

    const nextExpectedPayment = (funding.payments || [])
      .filter((payment) => ["Expected", "Scheduled", "Invoiced", "Delayed"].includes(payment.status) && payment.date)
      .sort((a, b) => dateWeight(a.date) - dateWeight(b.date))[0] || null;

    const actionByStatus = {
      Identified: t("app.getFundingQueueEntry.qualifyFit"),
      Qualified: t("app.getFundingQueueEntry.reachOut"),
      Contacted: t("app.getFundingQueueEntry.bookDiscovery"),
      Discovery: t("app.getFundingQueueEntry.defineScope"),
      "Scope Defined": t("app.getFundingQueueEntry.sendProposal"),
      "Proposal Sent": t("app.getFundingQueueEntry.followUp"),
      Negotiation: t("app.getFundingQueueEntry.closeTerms"),
      "Due Diligence": t("app.getFundingQueueEntry.completeDueDiligence"),
      "Terms Offered": t("app.getFundingQueueEntry.reviewTerms"),
      Committed: t("app.getFundingQueueEntry.confirmSigningAndPayment"),
      Awarded: t("app.getFundingQueueEntry.confirmPaymentSchedule"),
      "On Hold": t("app.getFundingQueueEntry.reviewHold"),
      Applied: t("app.getFundingQueueEntry.followUp"),
      "Partially Received": t("app.getFundingQueueEntry.collectBalance"),
      "Fully Received": t("app.getFundingQueueEntry.closeOut"),
      Withdrawn: t("app.getFundingQueueEntry.archiveNotes"),
      Declined: t("app.getFundingQueueEntry.recordLearnings"),
      "Closed Won": nextExpectedPayment ? t("app.getFundingQueueEntry.collectExpectedPayment") : t("app.getFundingQueueEntry.confirmTransferPlan"),
      "Closed Lost": t("app.getFundingQueueEntry.archiveNotes"),
    };

    let summary = funding.nextAction || funding.opportunity || funding.sourceType || t("app.getFundingQueueEntry.reviewDeal");
    if (nextExpectedPayment) {
      summary = `${formatCompactAmount(nextExpectedPayment.amount, nextExpectedPayment.currency || "EUR")} expected${nextExpectedPayment.notes ? ` - ${nextExpectedPayment.notes}` : ""}`;
    } else if (!funding.nextAction && funding.notes) {
      summary = funding.notes;
    }
    if (funding.owner) summary += ` ${t("app.getFundingQueueEntry.owner", { owner: funding.owner })}`;

    // Prefer the explicit next-action date (drives the Funding focus queue's "Due by").
    const focusDate = funding.nextActionDate || nextExpectedPayment?.date || "";
    const focusTime = funding.nextActionDate ? (funding.nextActionTime || "") : "";

    const value = {
      id: funding.id,
      title: funding.funder,
      status: funding.status,
      priority: funding.priority,
      actionLabel: actionByStatus[funding.status] || t("app.getFundingQueueEntry.reviewConversation"),
      summary,
      date: focusDate,
      time: focusTime,
      link: funding.funderLink || "",
      updatedAt: funding.updatedAt || "",
    };
    fundingQueueCache.set(funding, { revision: derivedDataRevision, value });
    return value;
  }

  function renderFundingRounds() {
    if (!elements.fundingRoundList) return;
    if (!state.fundingRounds.length) {
      elements.fundingRoundList.innerHTML = `<div class="empty-state compact"><h3>${escapeHtml(t("app.renderFundingRounds.noFundingRoundsYet"))}</h3><p>${escapeHtml(t("app.renderFundingRounds.addARoundWhenYou"))}</p></div>`;
      return;
    }

    elements.fundingRoundList.innerHTML = state.fundingRounds
      .slice()
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .map((round) => {
        const deals = state.funding.filter((funding) => funding.roundId === round.id);
        const commitments = deals.flatMap((funding) => funding.commitments || []).filter((entry) => entry.currency === round.currency);
        const received = deals.flatMap((funding) => funding.payments || []).filter((entry) => entry.currency === round.currency && ["Received", "Partially Received"].includes(entry.status));
        const committedAmount = commitments.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
        const receivedAmount = received.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
        const weightedAmount = deals
          .filter((funding) => funding.askCurrency === round.currency)
          .reduce((sum, funding) => sum + (Number(funding.askAmount) || 0) * ((Number(funding.probability) || 0) / 100), 0);
        const progress = round.targetAmount > 0 ? Math.min(100, Math.round((committedAmount / round.targetAmount) * 100)) : 0;
        return `<article class="manager-card funding-round-card" data-round-id="${escapeAttribute(round.id)}">
          <div class="manager-card-header">
            <div><strong>${escapeHtml(round.name)}</strong><span>${escapeHtml(t("app.counts.linkedDeal", { count: deals.length }))} · ${tHtml("app.counts.committedPercent", { progress })}</span></div>
            <button class="icon-button danger-button" type="button" data-round-action="delete" data-id="${escapeAttribute(round.id)}" aria-label="${escapeAttribute(t("app.renderFundingRounds.deleteFundingRound"))}"><svg><use href="#icon-trash"></use></svg></button>
          </div>
          <div class="manager-card-grid">
            <label>${escapeHtml(t("app.renderFundingRounds.roundName"))}<input class="inline-input" data-round-field="name" data-id="${escapeAttribute(round.id)}" value="${escapeAttribute(round.name)}"></label>
            <label>${escapeHtml(t("ui.common.stage"))}<input class="inline-input" data-round-field="stage" data-id="${escapeAttribute(round.id)}" value="${escapeAttribute(round.stage)}"></label>
            <label>${escapeHtml(t("app.renderFundingRounds.target"))}<input class="inline-input" type="number" min="0" step="any" data-round-field="targetAmount" data-id="${escapeAttribute(round.id)}" value="${round.targetAmount || ""}"></label>
            <label>${escapeHtml(t("app.renderFundingRounds.currency"))}<input class="inline-input" maxlength="3" data-round-field="currency" data-id="${escapeAttribute(round.id)}" value="${escapeAttribute(round.currency)}"></label>
            <label>${escapeHtml(t("app.renderFundingRounds.minimumClose"))}<input class="inline-input" type="number" min="0" step="any" data-round-field="minimumClose" data-id="${escapeAttribute(round.id)}" value="${round.minimumClose || ""}"></label>
            <label>${escapeHtml(t("app.renderFundingRounds.expectedClose"))}<input class="inline-input" type="date" data-round-field="expectedCloseDate" data-id="${escapeAttribute(round.id)}" value="${escapeAttribute(round.expectedCloseDate)}"></label>
          </div>
          <div class="card-meta">
            <span class="meta-item">${tHtml("app.renderFundingRounds.target2", { targetAmount: formatCompactAmount(round.targetAmount, round.currency) })}</span>
            <span class="meta-item">${tHtml("app.renderFundingRounds.committed", { committedAmount: formatCompactAmount(committedAmount, round.currency) })}</span>
            <span class="meta-item">${tHtml("app.renderFundingRounds.received", { receivedAmount: formatCompactAmount(receivedAmount, round.currency) })}</span>
            <span class="meta-item">${tHtml("app.renderFundingRounds.weightedAsks", { weightedAmount: formatCompactAmount(weightedAmount, round.currency) })}</span>
          </div>
        </article>`;
      }).join("");
  }

  function getCampaignName(campaignId) {
    if (!campaignId) return "";
    const campaign = state.campaigns.find((c) => c.id === campaignId);
    return campaign ? campaign.name : "";
  }

  function getFundingCategoryName(categoryId) {
    return categoryId ? Taxonomy.name(categoryId) : t("app.getFundingCategoryName.uncategorized");
  }

  function scrollActiveTabIntoView(container) {
    if (!container) return;
    const active = container.querySelector('[aria-selected="true"]');
    if (!active) return;
    const containerRect = container.getBoundingClientRect();
    if (containerRect.width === 0) return;
    const activeRect = active.getBoundingClientRect();
    if (activeRect.left < containerRect.left) {
      container.scrollLeft += (activeRect.left - containerRect.left);
    } else if (activeRect.right > containerRect.right) {
      container.scrollLeft += (activeRect.right - containerRect.right);
    }
  }

  function enableHorizontalScroll(container) {
    if (!container || container.dataset.hscrollEnabled === "true") return;
    container.dataset.hscrollEnabled = "true";

    // 1. Mouse wheel horizontal scrolling
    container.addEventListener("wheel", (e) => {
      if (container.scrollWidth <= container.clientWidth) return;
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        const maxScroll = container.scrollWidth - container.clientWidth;
        const canScrollLeft = container.scrollLeft > 0;
        const canScrollRight = container.scrollLeft < maxScroll - 1;

        if ((e.deltaY > 0 && canScrollRight) || (e.deltaY < 0 && canScrollLeft)) {
          container.scrollLeft += e.deltaY;
          e.preventDefault();
        }
      }
    }, { passive: false });

    // 2. Click and drag to scroll (grab to scroll)
    let isDown = false;
    let startClientX = 0;
    let initialScrollLeft = 0;
    let hasDragged = false;

    container.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      // A row that already fits has nothing to drag, and counting a small mouse
      // move as a drag there would swallow the click that came with it.
      if (container.scrollWidth <= container.clientWidth) return;
      isDown = true;
      hasDragged = false;
      startClientX = e.clientX;
      initialScrollLeft = container.scrollLeft;
    });

    window.addEventListener("mouseup", () => {
      if (isDown) {
        isDown = false;
        setTimeout(() => {
          hasDragged = false;
        }, 50);
      }
    });

    container.addEventListener("mousemove", (e) => {
      if (!isDown) return;
      const walk = e.clientX - startClientX;
      if (Math.abs(walk) > 4) {
        hasDragged = true;
        container.scrollLeft = initialScrollLeft - walk;
      }
    });

    container.addEventListener("click", (e) => {
      if (hasDragged) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    }, true);
  }

  function initAllHorizontalScrollContainers() {
    // The modal tab rows are in here too. The fitter shrinks a long row to keep it
    // on one line, and once even the smallest size does not fit, the row scrolls;
    // dragging it is then the only way to reach the last tab with a mouse.
    const scrollContainers = document.querySelectorAll(
      ".category-tabs, .subcategory-tabs, .app-tabs, .drawer-tabs, .extra-subnav, .company-subnav, [role='tablist']"
    );
    scrollContainers.forEach((container) => {
      enableHorizontalScroll(container);
    });
  }

  // Every .modal-overlay shares one z-index, so which of two open overlays paints
  // on top comes down to their order in index.html. The markdown preview and the
  // restore confirmation are both written before the record modals they open
  // from, and both opened behind them; the same trap waits for any dialog added
  // above an existing one. Ordering the markup by hand would only hold until the
  // next dialog, so the stack is tracked here: an overlay that opens while
  // another one is already open is lifted above it, and drops back to the
  // stylesheet's value once it closes.
  const OVERLAY_BASE_Z_INDEX = 1100;
  const OVERLAY_STACK_STEP = 10;

  function initOverlayStacking() {
    const overlays = [...document.querySelectorAll(".modal-overlay")];
    if (!overlays.length) return;
    const openOverlays = new Set();

    const zIndexOf = (overlay) => {
      const value = Number.parseInt(window.getComputedStyle(overlay).zIndex, 10);
      return Number.isFinite(value) ? value : OVERLAY_BASE_Z_INDEX;
    };

    const lift = (overlay) => {
      let highest = 0;
      for (const other of openOverlays) {
        if (other !== overlay) highest = Math.max(highest, zIndexOf(other));
      }
      // With nothing else open the stylesheet value is already right, and an
      // inline one would only carry over into the next time it opens.
      overlay.style.zIndex = highest
        ? String(Math.max(highest, OVERLAY_BASE_Z_INDEX) + OVERLAY_STACK_STEP)
        : "";
    };

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const overlay = record.target;
        if (overlay.classList.contains("open")) {
          // Only the moment it opens. A class change on an overlay that is
          // already open must not lift it over whatever opened on top of it.
          if (openOverlays.has(overlay)) continue;
          openOverlays.add(overlay);
          lift(overlay);
          continue;
        }
        if (!openOverlays.delete(overlay)) continue;
        // Cleared after the fade rather than with it: dropping the z-index while
        // the overlay is still visible would hide it behind the one underneath
        // halfway through closing.
        window.setTimeout(() => {
          if (!overlay.classList.contains("open")) overlay.style.zIndex = "";
        }, 320);
      }
    });

    overlays.forEach((overlay) => {
      observer.observe(overlay, { attributes: true, attributeFilter: ["class"] });
    });
  }

  // ---- Category tabs (MK, PO, FU) ---------------------------------------------
  //
  // Three rows per section, from the shared library (js/taxonomy-model.js):
  // categories, the chosen category's subcategories, the chosen
  // subcategory's types. A target counts under every branch one of its nodes
  // falls in, so the per-tab counts can add up to more than "All", which
  // counts each target once. Nodes this startup turned off have no tab.

  const TAXONOMY_VIEWS = {
    mk: {
      records: () => state.items,
      keys: ["selectedCategory", "selectedSubcategory", "selectedMkType"],
      rows: () => [elements.categoryTabs, elements.subcategoryTabs, elements.mkTypeTabs],
      changed: () => {
        if (sectionPages.mk) sectionPages.mk.ui.page = 1;
        renderSectionPage("mk");
      },
    },
    po: {
      records: () => state.programs,
      keys: ["selectedProgramCategory", "selectedProgramType", "selectedProgramNodeType"],
      rows: () => [elements.programCategoryTabs, elements.programTypeTabs, elements.programNodeTypeTabs],
      changed: () => {
        if (sectionPages.po) sectionPages.po.ui.page = 1;
        renderSectionPage("po");
      },
    },
    fu: {
      records: () => state.funding,
      keys: ["selectedFundingCategory", "selectedFundingType", "selectedFundingNodeType"],
      rows: () => [elements.fundingCategoryTabs, elements.fundingTypeTabs, elements.fundingNodeTypeTabs],
      changed: () => {
        if (sectionPages.fu) sectionPages.fu.ui.page = 1;
        renderSectionPage("fu");
      },
    },
  };

  // The deepest tab chosen in a section, or "all".
  function selectedTaxonomyNode(section) {
    const view = TAXONOMY_VIEWS[section];
    for (const key of [...view.keys].reverse()) {
      if (state[key] && state[key] !== "all") return state[key];
    }
    return "all";
  }

  function matchesTaxonomyTabs(section, record) {
    return Taxonomy.inBranch(record.taxonomy, selectedTaxonomyNode(section));
  }

  function taxonomyTabButton({ id, label, count, level, selected, nodeId }) {
    return `
      <button
        class="${level === 0 ? "tab-button" : "subtab-button"}"
        type="button"
        role="tab"
        aria-selected="${selected}"
        data-taxonomy-tab="${escapeAttribute(id)}"
        data-taxonomy-level="${level}"
        data-tooltip-type="taxonomy"
        data-node-id="${escapeAttribute(nodeId)}"
      >
        ${escapeHtml(label)}
        <span class="tab-count">${count}</span>
      </button>
    `;
  }

  function renderTaxonomyTabs(section) {
    const view = TAXONOMY_VIEWS[section];
    const rows = view.rows();
    if (!rows[0]) return;
    const records = view.records() || [];
    const countIn = (nodeId) => records.reduce((sum, record) => sum + (Taxonomy.inBranch(record.taxonomy, nodeId) ? 1 : 0), 0);
    // A chosen tab this startup turned off, or that the library lost, is let go.
    view.keys.forEach((key, level) => {
      const value = state[key];
      if (value && value !== "all" && (!Taxonomy.isKnown(value) || !Taxonomy.isEnabled(value) || (level > 0 && Taxonomy.get(value)?.parentId !== state[view.keys[level - 1]]))) {
        view.keys.slice(level).forEach((later) => { state[later] = "all"; });
      }
    });

    let parentId = null;
    rows.forEach((row, level) => {
      if (!row) return;
      const nodes = level === 0
        ? Taxonomy.categories(section, { onlyEnabled: true })
        : (parentId ? Taxonomy.children(parentId, section, { onlyEnabled: true }) : []);
      if (level > 0 && !nodes.length) {
        row.style.display = "none";
        row.innerHTML = "";
        parentId = null;
        return;
      }
      row.style.display = "";
      const key = view.keys[level];
      const current = state[key] || "all";
      const allLabel = level === 0 ? t("app.renderTaxonomyTabs.all2") : t("app.renderTaxonomyTabs.all", { parentId: Taxonomy.shortName(parentId) });
      const allCount = level === 0 ? records.length : countIn(parentId);
      row.innerHTML = [
        taxonomyTabButton({ id: "all", label: allLabel, count: allCount, level, selected: current === "all", nodeId: level === 0 ? `all:${section}` : parentId }),
        ...nodes.map((node) => taxonomyTabButton({
          id: node.id,
          label: level === 0 ? (node.shortName || node.name) : node.name,
          count: countIn(node.id),
          level,
          selected: current === node.id,
          nodeId: node.id,
        })),
      ].join("");
      scrollActiveTabIntoView(row);
      parentId = current === "all" ? null : current;
    });
  }

  function bindTaxonomyTabs(section) {
    const view = TAXONOMY_VIEWS[section];
    view.rows().forEach((row, level) => {
      if (!row) return;
      enableHorizontalScroll(row);
      row.addEventListener("click", (event) => {
        const button = event.target.closest("[data-taxonomy-tab]");
        if (!button) return;
        state[view.keys[level]] = button.dataset.taxonomyTab;
        view.keys.slice(level + 1).forEach((key) => { state[key] = "all"; });
        view.changed();
      });
    });
  }

  // The tooltip of a category, subcategory or type: its place in the tree,
  // its description and what lies under it.
  function formatTaxonomyTooltip(nodeId) {
    const node = Taxonomy.get(nodeId);
    if (!node) {
      return `
        <div class="tooltip-title">${escapeHtml(String(nodeId || ""))}</div>
        <div class="tooltip-body">${escapeHtml(t("taxonomy.unknownHelp"))}</div>
      `;
    }
    const path = Taxonomy.path(nodeId);
    const parents = path.slice(0, -1).map((entry) => entry.name).join(" > ");
    const children = Taxonomy.children(nodeId, node.section, { onlyEnabled: true });
    return `
      <div class="tooltip-title">${escapeHtml(node.name)}</div>
      ${parents ? `<div class="tooltip-heading">${escapeHtml(parents)}</div>` : ""}
      <div class="tooltip-section">
        <div class="tooltip-body">${escapeHtml(node.description || "")}</div>
      </div>
      ${children.length ? `
      <div class="tooltip-section">
        <div class="tooltip-heading">${escapeHtml(t(node.level === "category" ? "taxonomy.subcategories" : "taxonomy.types"))}</div>
        <div class="tooltip-body">${escapeHtml(children.map((child) => child.name).join(", "))}</div>
      </div>` : ""}
      ${Taxonomy.isEnabled(nodeId) ? "" : `<div class="tooltip-section"><div class="tooltip-body">${escapeHtml(t("taxonomy.disabledHelp"))}</div></div>`}
    `;
  }

  // ---- Calendar ------------------------------------------------------------
  //
  // Events come from js/calendar-model.js, the same source the server's
  // "all startups" calendar uses. They are grouped by section (marketing,
  // programs, funding, company) plus campaigns, and filtered by the section
  // toggles, the event types and the shared status filter.

  const CALENDAR_GROUP_KEYS = ["marketing", "programs", "funding", "company", "campaigns"];

  function emptyCalendarGroups() {
    return Object.fromEntries(CALENDAR_GROUP_KEYS.map((key) => [key, []]));
  }

  function calendarGroupKey(section) {
    return Sections.byId(section)?.group || "campaigns";
  }

  function calendarEventType(section) {
    return Sections.byId(section)?.calendarType || "campaign";
  }

  function sortCalendarEvents(events) {
    return events.sort((a, b) => {
      const dateDiff = dateWeight(a.date, a.time) - dateWeight(b.date, b.time);
      if (dateDiff !== 0) return dateDiff;
      return String(a.label || "").localeCompare(String(b.label || ""));
    });
  }

  function sortCalendarGroups(groups) {
    CALENDAR_GROUP_KEYS.forEach((key) => sortCalendarEvents(groups[key]));
    return groups;
  }

  // Every dated moment of this startup's records.
  function buildCalendarEventGroups() {
    const groups = emptyCalendarGroups();
    const add = (event) => {
      const entry = { ...event, type: calendarEventType(event.section) };
      if (event.section === "mk" && !entry.detail) {
        const item = state.items.find((candidate) => candidate.id === event.id);
        entry.detail = getCategory(item?.category)?.shortName || item?.category || "";
      }
      groups[calendarGroupKey(event.section)].push(entry);
    };
    state.items.forEach((record) => Calendar.recordEvents("items", record).forEach(add));
    state.programs.forEach((record) => Calendar.recordEvents("programs", record).forEach(add));
    state.funding.forEach((record) => Calendar.recordEvents("funding", record).forEach(add));
    state.campaigns.forEach((record) => Calendar.recordEvents("campaigns", record).forEach(add));
    companyCalendarEvents().forEach(add);
    return sortCalendarGroups(groups);
  }

  // "Due by": one entry per record, its next date from the focus queues, plus
  // the Company entries still open.
  function buildCalendarDueByGroups() {
    const groups = emptyCalendarGroups();
    state.items.filter((item) => item.date).forEach((item) => {
      groups.marketing.push({
        id: item.id,
        section: "mk",
        kind: "next_action",
        label: item.platform,
        detail: getCategory(item.category)?.shortName || (item.category || ""),
        status: item.status,
        type: "pipeline",
        date: item.date,
        time: item.time || "",
      });
    });
    state.programs.forEach((program) => {
      const queueEntry = getProgramQueueEntry(program);
      if (!queueEntry?.date) return;
      groups.programs.push({
        id: program.id,
        section: "po",
        kind: "next_action",
        label: queueEntry.title || program.name || program.applicationName || t("app.buildCalendarDueByGroups.programOpportunity"),
        detail: queueEntry.actionLabel || "",
        status: program.status,
        type: "program",
        date: queueEntry.date,
        time: queueEntry.time || "",
      });
    });
    state.funding.forEach((funding) => {
      const queueEntry = getFundingQueueEntry(funding);
      if (!queueEntry?.date) return;
      groups.funding.push({
        id: funding.id,
        section: "fu",
        kind: "next_action",
        label: queueEntry.title || funding.funder || t("ui.common.funding"),
        detail: queueEntry.actionLabel || "",
        status: funding.status,
        type: "funding",
        date: queueEntry.date,
        time: queueEntry.time || "",
      });
    });
    companyCalendarEvents()
      .filter((event) => Statuses.isOpen(event.status))
      .forEach((event) => groups.company.push({ ...event, type: "company" }));
    return sortCalendarGroups(groups);
  }

  function getCalendarEventGroups(mode) {
    const localGroups = getStartupCalendarEventGroups(mode);
    return state.calendarScope === SCOPE_ALL ? combineCalendarEventGroups(mode, localGroups) : localGroups;
  }

  function getStartupCalendarEventGroups(mode) {
    const useDueByGroups = mode === "by";
    if (!calendarEventsCache || calendarEventsCache.revision !== derivedDataRevision) {
      calendarEventsCache = { revision: derivedDataRevision, eventGroups: null, dueByGroups: null };
    }
    const key = useDueByGroups ? "dueByGroups" : "eventGroups";
    if (!calendarEventsCache[key]) {
      calendarEventsCache[key] = useDueByGroups ? buildCalendarDueByGroups() : buildCalendarEventGroups();
    }
    return calendarEventsCache[key];
  }

  // ---- calendar filters ----------------------------------------------------

  // The calendar's status filter as a set of status ids. "all" and a set
  // are accepted as they are; anything else is a stored list.
  function getCalendarStatusFilterIds(filterVal) {
    if (filterVal instanceof Set) return filterVal;
    if (filterVal === "all") return Statuses.allSelection();
    return statusSelection(filterVal);
  }

  function calendarFilters({ statuses = true } = {}) {
    const selection = getCalendarStatusFilterIds(state.calendarStatusFilter);
    return {
      sections: state.calendarSections,
      kinds: state.calendarKinds,
      matchesStatus: statuses ? (status) => Statuses.matches(selection, status) : null,
    };
  }

  function filterCalendarGroups(groups, filters) {
    return Object.fromEntries(CALENDAR_GROUP_KEYS.map((key) => [key, (groups[key] || []).filter((event) => Calendar.eventMatches(event, filters))]));
  }

  function flattenCalendarGroups(groups) {
    return CALENDAR_GROUP_KEYS.flatMap((key) => groups[key] || []);
  }

  // The section toggles, event types and status filter are remembered per
  // startup.
  function readCalendarFilters() {
    let stored = null;
    try {
      stored = JSON.parse(localStorage.getItem(CALENDAR_FILTERS_STORAGE_KEY) || "null");
    } catch {
      stored = null;
    }
    const pick = (list, allowed, fallback) => {
      if (!Array.isArray(list)) return fallback;
      return new Set(list.filter((id) => allowed.includes(id)));
    };
    state.calendarSections = pick(stored?.sections, Sections.IDS, new Set(Sections.IDS));
    state.calendarKinds = pick(stored?.kinds, Calendar.EVENT_KINDS.map((kind) => kind.id), Calendar.defaultKinds());
    state.calendarSummaryRange = stored?.summaryRange === "all" ? "all" : "range";
    if (Array.isArray(stored?.statuses)) state.calendarStatusFilter = restoreStatusFilter(stored.statuses);
  }

  function storeCalendarFilters() {
    try {
      localStorage.setItem(CALENDAR_FILTERS_STORAGE_KEY, JSON.stringify({
        sections: [...state.calendarSections],
        kinds: [...state.calendarKinds],
        statuses: Array.isArray(state.calendarStatusFilter) ? state.calendarStatusFilter : null,
        summaryRange: state.calendarSummaryRange,
      }));
    } catch {
      // Remembering the filters is a convenience only.
    }
  }

  function toggleCalendarSection(sectionId) {
    const next = new Set(state.calendarSections);
    if (next.has(sectionId)) next.delete(sectionId);
    else next.add(sectionId);
    state.calendarSections = next;
    storeCalendarFilters();
    renderCalendarTab();
  }

  function toggleCalendarKind(kindId) {
    const next = new Set(state.calendarKinds);
    if (next.has(kindId)) next.delete(kindId);
    else next.add(kindId);
    state.calendarKinds = next;
    storeCalendarFilters();
    renderCalendarTab();
  }

  function sectionName(sectionId) {
    return t(`sections.${sectionId}.name`);
  }

  // Section toggles and event types, above the status filter.
  function renderCalendarToggles() {
    const holder = elements.calendarToggles;
    if (!holder) return;
    const sectionButtons = Sections.SECTIONS.map((section) => `
      <button type="button" class="calendar-toggle section-chip" data-section="${section.id}" data-calendar-section="${section.id}" aria-pressed="${state.calendarSections.has(section.id)}">
        <span aria-hidden="true">${escapeHtml(section.short)}</span> ${escapeHtml(sectionName(section.id))}
      </button>`).join("");
    const kindButtons = Calendar.EVENT_KINDS.map((kind) => `
      <button type="button" class="calendar-toggle" data-calendar-kind="${kind.id}" aria-pressed="${state.calendarKinds.has(kind.id)}">${escapeHtml(t(`calendar.kinds.${kind.id}`))}</button>`).join("");
    holder.innerHTML = `
      <div class="calendar-toggle-row" role="group" aria-label="${escapeAttribute(t("calendar.sectionsLabel"))}">${sectionButtons}</div>
      <div class="calendar-toggle-row" role="group" aria-label="${escapeAttribute(t("calendar.kindsLabel"))}">
        <span class="calendar-toggle-label">${escapeHtml(t("calendar.kindsLabel"))}</span>${kindButtons}
      </div>`;
    holder.querySelectorAll("[data-calendar-section]").forEach((button) => {
      button.addEventListener("click", () => toggleCalendarSection(button.dataset.calendarSection));
    });
    holder.querySelectorAll("[data-calendar-kind]").forEach((button) => {
      button.addEventListener("click", () => toggleCalendarKind(button.dataset.calendarKind));
    });
  }

  function renderCalendarFilterBar(eventGroups) {
    if (!elements.calendarFilterBar) return;
    StatusFilter.render(elements.calendarFilterBar, {
      title: t("statusFilter.calendarTitle"),
      selection: getCalendarStatusFilterIds(state.calendarStatusFilter),
      counts: Statuses.countByStatus(flattenCalendarGroups(eventGroups).filter((event) => event.section !== "campaign")),
      onChange: (next) => {
        state.calendarStatusFilter = [...next];
        storeCalendarFilters();
        renderCalendarTab();
      },
    });
  }

  // The events of one day ("on") or due on or before it ("by"), filtered.
  function getCalendarEventsForDate(calendarEvents, dateStr, mode = "on", filters = null) {
    if (!dateStr) return emptyCalendarGroups();
    const dueByMode = mode === "by";
    const groups = Object.fromEntries(CALENDAR_GROUP_KEYS.map((key) => [key, (calendarEvents[key] || []).filter((event) => {
      if (!event.date) return false;
      return dueByMode ? event.date <= dateStr : event.date === dateStr;
    })]));
    return filters ? filterCalendarGroups(groups, filters) : groups;
  }

  // ---- calendar day cards ----------------------------------------------------

  // "M2 P4 F1 C1": one count per visible section, its code and number in the
  // section colour, zeros left out. The tooltip splits each count by status
  // group, and screen readers hear the section names.
  function calendarDayCountsHtml(groups) {
    const parts = Sections.SECTIONS.map((section) => {
      const events = groups[section.group] || [];
      if (!events.length || !state.calendarSections.has(section.id)) return null;
      const byGroup = Calendar.countByGroup(events, Statuses.groupOf);
      const split = Object.entries(byGroup)
        .map(([group, count]) => `${group === Statuses.UNMAPPED ? t("statusFilter.unmapped") : Statuses.groupLabel(group)} ${count}`)
        .join(", ");
      const name = sectionName(section.id);
      return {
        chip: `<span class="summary-pill day-count" data-section="${section.id}" title="${escapeAttribute(`${name}: ${events.length} (${split})`)}" aria-hidden="true">${escapeHtml(section.code)}${events.length}</span>`,
        spoken: t("calendar.daySectionCount", { section: name, count: events.length }),
      };
    }).filter(Boolean);
    if (!parts.length) return `<div class="day-summary day-counts"></div>`;
    return `<div class="day-summary day-counts">${parts.map((part) => part.chip).join("")}<span class="visually-hidden">${escapeHtml(parts.map((part) => part.spoken).join(", "))}</span></div>`;
  }

  // The month panel's anchor: the first day of the month holding iso.
  function calendarMonthOf(iso) {
    return Dates.startOfMonth(Dates.isDateString(iso) ? iso : todayDate());
  }

  // The ISO week number of a calendar row. A row that starts on Sunday is
  // numbered by its Monday, so the number matches the days most of it holds.
  function getISOWeekNumber(iso) {
    if (!Dates.isDateString(iso)) return "";
    return Dates.isoWeekNumber(getWeekStart() === "sunday" && Dates.dayOfWeek(iso) === 0 ? Dates.addDays(iso, 1) : iso);
  }

  // Short weekday and month names of a calendar date, in the app's locale.
  function calendarDayLabels(iso) {
    if (!Dates.isDateString(iso)) return { dayName: "", dayNumber: "", monthName: "" };
    const locale = getLocale();
    return {
      dayName: Dates.formatDate(iso, locale, { weekday: "short" }),
      dayNumber: String(Dates.parseParts(iso).day),
      monthName: Dates.formatDate(iso, locale, { month: "short" }),
    };
  }

  function setCalendarMonthOpen(open) {
    state.calendarMonthOpen = !!open;
    if (elements.calendarMonthToggle) {
      elements.calendarMonthToggle.classList.toggle("active", state.calendarMonthOpen);
      elements.calendarMonthToggle.setAttribute("aria-expanded", String(state.calendarMonthOpen));
      elements.calendarMonthToggle.title = state.calendarMonthOpen ? t("calendar.closeMonth") : t("calendar.openMonth");
    }
    if (elements.calendarMonthPanel) {
      elements.calendarMonthPanel.hidden = !state.calendarMonthOpen;
    }
  }

  // The days the strip shows, or the month panel's weeks when it is open:
  // what "visible range" means for the summary.
  function calendarVisibleRange() {
    if (state.calendarMonthOpen) {
      const grid = Calendar.monthGrid(state.calendarMonthAnchor || calendarMonthOf(state.calendarSelectedDate), getWeekStart());
      return { from: grid.weeks[0][0], to: grid.weeks[grid.weeks.length - 1][6] };
    }
    return { from: shiftDateISO(state.calendarCenterDate, -4), to: shiftDateISO(state.calendarCenterDate, 4) };
  }

  // A real month: whole weeks from the one holding the 1st to the one holding
  // the last day, five or six rows.
  function renderCalendarMonthPanel(calendarEvents, calendarMode, filters) {
    if (!state.calendarMonthOpen || !elements.calendarMonthPanel || !elements.calendarMonthGrid) return;
    if (!state.calendarMonthAnchor) state.calendarMonthAnchor = calendarMonthOf(state.calendarSelectedDate);

    const todayStr = todayDate();
    const grid = Calendar.monthGrid(state.calendarMonthAnchor, getWeekStart());
    const monthEvents = [];
    let gridHtml = "";
    for (const week of grid.weeks) {
      gridHtml += `<div class="calendar-month-week-number">${getISOWeekNumber(week[0])}</div>`;
      for (const curDate of week) {
        const { dayName, dayNumber: dayNum, monthName } = calendarDayLabels(curDate);
        const isOtherMonth = curDate.slice(0, 7) !== grid.month;
        const classes = [
          "calendar-day-card",
          "calendar-month-cell",
          curDate.endsWith("-01") ? "month-start" : "",
          isOtherMonth ? "other-month" : "",
          curDate === todayStr ? "today" : "",
          curDate === state.calendarSelectedDate ? "selected" : "",
        ].filter(Boolean).join(" ");
        const events = getCalendarEventsForDate(calendarEvents, curDate, calendarMode, filters);
        if (!isOtherMonth) monthEvents.push(...flattenCalendarGroups(events));
        gridHtml += `
          <button class="${classes}" type="button" data-date="${curDate}">
            <span class="day-name">${dayName}</span>
            <span class="day-number">${dayNum}</span>
            <span class="day-month">${monthName}</span>
            ${calendarDayCountsHtml(events)}
          </button>
        `;
      }
    }

    elements.calendarMonthGrid.innerHTML = gridHtml;
    elements.calendarMonthGrid.querySelectorAll(".calendar-month-cell").forEach((cell) => {
      cell.addEventListener("click", () => {
        state.calendarSelectedDate = cell.dataset.date;
        state.calendarCenterDate = cell.dataset.date;
        setCalendarMonthOpen(false);
        render();
      });
    });

    if (elements.calendarMonthTitle) {
      const counts = Calendar.countBySection(monthEvents);
      const pills = Sections.SECTIONS
        .filter((section) => state.calendarSections.has(section.id) && counts[section.id] > 0)
        .map((section) => `<span class="cal-title-badge" data-section="${section.id}" title="${escapeAttribute(sectionName(section.id))}">${escapeHtml(section.code)}${counts[section.id]}</span>`);
      const monthName = Dates.formatDate(grid.first, getLocale(), { month: "long", year: "numeric" });
      elements.calendarMonthTitle.innerHTML = `
        <span class="calendar-month-date-range">${escapeHtml(monthName)}</span>
        ${pills.length ? `<span class="calendar-month-counts">${pills.join(" ")}</span>` : ""}
      `.trim();
    }
  }

  function renderCalendarTab(requestedDirection = null) {
    if (state.selectedAppTab !== "calendar") return;
    if (!elements.calendarView) return;
    if (state.calendarScope === SCOPE_ALL && !state.isInitialLoading) ensureAllStartupsCalendar();
    renderCalendarScope();
    renderCalendarToggles();

    if (state.isInitialLoading) {
      let stripHtml = "";
      for (let i = 0; i < 9; i++) {
        stripHtml += `<button class="calendar-day-card skeleton" type="button"><span class="day-name">...</span><span class="day-number">--</span><span class="day-month">...</span></button>`;
      }
      if (elements.calendarDaysStrip) {
        elements.calendarDaysStrip.innerHTML = stripHtml;
      }
      if (elements.calendarDetailTitle) {
        elements.calendarDetailTitle.textContent = t("app.renderCalendarTab.loadingData");
      }
      const loadingListHtml = `<div class="calendar-empty-text">${escapeHtml(t("app.renderCalendarTab.loading"))}</div>`;
      Object.values(calendarLists()).forEach((list) => { if (list) list.innerHTML = loadingListHtml; });
      return;
    }

    const todayStr = todayDate();
    const calendarMode = state.calendarDateMode === "by" ? "by" : "on";
    const filters = calendarFilters();
    const calendarEvents = getCalendarEventGroups(calendarMode);

    const countAll = (groups) => flattenCalendarGroups(groups).length;
    const onCount = countAll(getCalendarEventsForDate(getCalendarEventGroups("on"), state.calendarSelectedDate, "on", filters));
    const byCount = countAll(getCalendarEventsForDate(getCalendarEventGroups("by"), state.calendarSelectedDate, "by", filters));

    elements.calendarModeButtons.forEach((btn) => {
      const btnMode = btn.dataset.calendarMode === "by" ? "by" : "on";
      btn.classList.toggle("active", btnMode === calendarMode);
      let countEl = btn.querySelector(".tab-count");
      if (!countEl) {
        countEl = document.createElement("span");
        countEl.className = "tab-count";
        btn.appendChild(countEl);
      }
      countEl.textContent = String(btnMode === "by" ? byCount : onCount);
    });

    // 1. Nine day cards around the centre date.
    let stripHtml = "";
    for (let i = -4; i <= 4; i++) {
      const curDate = shiftDateISO(state.calendarCenterDate, i);
      const { dayName, dayNumber: dayNum, monthName } = calendarDayLabels(curDate);
      const events = getCalendarEventsForDate(calendarEvents, curDate, calendarMode, filters);
      const todayClass = curDate === todayStr ? "today" : "";
      const selectedClass = curDate === state.calendarSelectedDate ? "selected" : "";
      stripHtml += `
        <button class="calendar-day-card ${todayClass} ${selectedClass}" type="button" data-date="${curDate}">
          <span class="day-name">${dayName}</span>
          <span class="day-number">${dayNum}</span>
          <span class="day-month">${monthName}</span>
          ${calendarDayCountsHtml(events)}
        </button>
      `;
    }

    const stripEl = elements.calendarDaysStrip || document.querySelector("#calendarDaysStrip");
    if (stripEl) {
      stripEl.innerHTML = stripHtml;
      stripEl.querySelectorAll(".calendar-day-card").forEach((card) => {
        card.addEventListener("click", () => {
          state.calendarSelectedDate = card.dataset.date;
          render();
        });
      });
    }

    const selectedCard = stripEl?.querySelector(".calendar-day-card.selected");
    if (selectedCard && elements.calendarStripViewport && elements.calendarStripViewport.scrollWidth > elements.calendarStripViewport.clientWidth) {
      const cardOffsetLeft = selectedCard.offsetLeft;
      const cardWidth = selectedCard.offsetWidth;
      const containerWidth = elements.calendarStripViewport.clientWidth;
      const targetScrollLeft = cardOffsetLeft - (containerWidth / 2) + (cardWidth / 2);
      elements.calendarStripViewport.scrollTo({
        left: Math.max(0, targetScrollLeft),
        behavior: "smooth"
      });
    }

    if (state.calendarMonthOpen) {
      renderCalendarMonthPanel(calendarEvents, calendarMode, filters);
    }

    if (elements.calendarDetailSections) {
      elements.calendarDetailSections.classList.remove("cal-anim-fade");
      void elements.calendarDetailSections.offsetHeight;
      elements.calendarDetailSections.classList.add("cal-anim-fade");
    }

    // 2. The selected day's events, by section.
    const fullDateStr = Dates.isDateString(state.calendarSelectedDate)
      ? Dates.formatDate(state.calendarSelectedDate, getLocale(), { weekday: "long", day: "numeric", month: "long", year: "numeric" })
      : state.calendarSelectedDate;

    elements.calendarDetailTitle.textContent = calendarMode === "by"
      ? (state.calendarSelectedDate === todayStr ? t("app.renderCalendarTab.dueByToday") : t("app.renderCalendarTab.dueBy", { fullDateStr }))
      : fullDateStr;

    // The status filter counts what the other filters leave.
    renderCalendarFilterBar(getCalendarEventsForDate(calendarEvents, state.calendarSelectedDate, calendarMode, calendarFilters({ statuses: false })));
    const events = getCalendarEventsForDate(calendarEvents, state.calendarSelectedDate, calendarMode, filters);
    const emptyText = calendarMode === "by"
      ? t("app.renderCalendarTab.noMatchingItemsDueOn")
      : t("app.renderCalendarTab.noMatchingItemsScheduled");

    const renderItems = (items) => {
      if (items.length === 0) {
        return `<div class="calendar-empty-text">${escapeHtml(emptyText)}</div>`;
      }
      return items.map((item) => {
        const statusHtml = item.section === "campaign"
          ? (item.status ? `<span class="cal-badge">${escapeHtml(Statuses.campaignStatusLabel(item.status))}</span>` : "")
          : (item.status ? statusBadgeHtml(item.status) : "");
        const kindHtml = item.kind ? `<span class="cal-badge type-${escapeAttribute(item.kind.replace(/_/g, "-"))}">${escapeHtml(t(`calendar.kinds.${item.kind}`))}</span>` : "";
        const detailHtml = item.detail ? `<span class="calendar-item-detail">${escapeHtml(item.detail)}</span>` : "";
        const dueText = calendarMode === "by"
          ? `<span class="calendar-item-detail">${tHtml("app.renderCalendarTab.due", { date: escapeHtml(formatDateTime(item.date, item.time)) })}</span>`
          : "";
        return `
          <button type="button" class="calendar-item-card" data-id="${escapeAttribute(item.id)}" data-type="${escapeAttribute(item.type)}"${item.parentId ? ` data-parent-id="${escapeAttribute(item.parentId)}" data-parent-kind="${escapeAttribute(item.parentKind || "step")}"` : ""}${item.startup ? ` data-startup-id="${escapeAttribute(item.startup.id)}"` : ""}>
            <span class="calendar-item-header">
              <strong class="calendar-item-title">${escapeHtml(item.label)}</strong>
              ${item.startup ? renderStartupChip(item.startup) : ""}
            </span>
            ${detailHtml}
            ${dueText}
            <span class="calendar-item-badges">${statusHtml}${kindHtml}</span>
          </button>
        `;
      }).join("");
    };

    const lists = calendarLists();
    Object.entries(lists).forEach(([key, list]) => {
      if (!list) return;
      const section = list.closest(".calendar-detail-section");
      const sectionId = Sections.byGroup(key)?.id || "";
      const visible = key === "campaigns" ? state.calendarKinds.has("campaign") : state.calendarSections.has(sectionId);
      if (section) section.hidden = !visible;
      list.innerHTML = visible ? renderItems(events[key] || []) : "";
      const heading = section?.querySelector("h4");
      if (heading) {
        const title = key === "campaigns" ? t("calendar.campaigns") : sectionName(sectionId);
        const chip = sectionId ? `<span class="section-chip" data-section="${sectionId}" aria-hidden="true">${escapeHtml(Sections.byId(sectionId).short)}</span>` : "";
        heading.innerHTML = `<span class="calendar-detail-heading">${chip}${escapeHtml(title)}</span> <span class="section-count">${(events[key] || []).length}</span>`;
      }
      list.querySelectorAll(".calendar-item-card").forEach((card) => {
        card.addEventListener("click", () => {
          jumpToCalendarItem(card.dataset.type, card.dataset.id, card.dataset.parentId, card.dataset.parentKind, card.dataset.startupId);
        });
      });
    });

    renderCalendarSummary();
  }

  function calendarLists() {
    return {
      marketing: elements.calListMarketing,
      programs: elements.calListPrograms,
      funding: elements.calListFunding,
      company: elements.calListCompany,
      campaigns: elements.calListCampaigns,
    };
  }

  // ---- calendar summary ----------------------------------------------------

  // Records per section for the "all time" summary: this startup's from the
  // page, the others' from /api/all/calendar.
  function calendarSummaryRecords() {
    const records = {
      mk: state.items.map((record) => ({ id: record.id, status: record.status })),
      po: state.programs.map((record) => ({ id: record.id, status: record.status })),
      fu: state.funding.map((record) => ({ id: record.id, status: record.status })),
      comp: CompanyModel.calendarRecords(currentCompanyView(), { defaultStatus: Statuses.defaultStatus() }),
    };
    if (state.calendarScope === SCOPE_ALL) {
      for (const record of state.allCalendar.records || []) {
        if (record.startupId === STARTUP_ID || !records[record.section]) continue;
        records[record.section].push(record);
      }
    }
    return records;
  }

  // Per section and status group: the items, and the events apart. It follows
  // the section toggles, the event types and the status filter, over the
  // visible days or all time.
  function calculateCalendarTotalSummary() {
    const filters = calendarFilters();
    const allTime = state.calendarSummaryRange === "all";
    const range = calendarVisibleRange();
    const events = flattenCalendarGroups(getCalendarEventGroups("on"))
      .filter((event) => event.section !== "campaign")
      .filter((event) => Calendar.eventMatches(event, { kinds: filters.kinds, matchesStatus: filters.matchesStatus }))
      .filter((event) => allTime || Calendar.inRange(event, range.from, range.to))
      .map((event) => (event.startup ? { ...event, startupId: event.startup.id } : event));
    const groupIds = [...Statuses.groups().map((group) => group.id), Statuses.UNMAPPED];
    const summary = Calendar.summarize({
      mode: allTime ? "all" : "range",
      events,
      records: calendarSummaryRecords(),
      sections: state.calendarSections,
      matchesStatus: filters.matchesStatus,
      groupOf: Statuses.groupOf,
      groupIds,
    });
    return { ...summary, range };
  }

  function renderCalendarSummary() {
    if (!elements.calendarSummaryContainer) return;
    const summary = calculateCalendarTotalSummary();
    const columns = Statuses.groups().map((group) => ({ id: group.id, label: group.label }));
    if (summary.rows.some((row) => row.counts[Statuses.UNMAPPED] > 0)) columns.push({ id: Statuses.UNMAPPED, label: t("statusFilter.unmapped") });
    const allTime = state.calendarSummaryRange === "all";
    const rangeText = allTime
      ? t("calendar.summary.allTimeHint")
      : t("calendar.summary.rangeHint", { from: formatDate(summary.range.from), to: formatDate(summary.range.to) });
    const cells = (counts, bold) => columns.map((column) => `<td class="text-right num-val${bold ? " font-bold" : ""}">${counts[column.id]}</td>`).join("");

    elements.calendarSummaryContainer.innerHTML = `
      <div class="calendar-summary-card">
        <div class="calendar-summary-header">
          <div class="calendar-summary-header-title">
            <svg class="calendar-summary-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="18" y1="20" x2="18" y2="10"></line>
              <line x1="12" y1="20" x2="12" y2="4"></line>
              <line x1="6" y1="20" x2="6" y2="14"></line>
            </svg>
            <h3>${escapeHtml(t("calendar.summary.title"))}</h3>
          </div>
          <div class="scope-switch calendar-summary-range" role="group" aria-label="${escapeAttribute(t("calendar.summary.rangeLabel"))}">
            <button type="button" class="scope-switch-button" data-summary-range="range" aria-pressed="${!allTime}">${escapeHtml(t("calendar.summary.range"))}</button>
            <button type="button" class="scope-switch-button" data-summary-range="all" aria-pressed="${allTime}">${escapeHtml(t("calendar.summary.allTime"))}</button>
          </div>
          <span class="calendar-summary-subtitle">${escapeHtml(rangeText)}</span>
        </div>

        <div class="calendar-summary-metrics-grid">
          ${columns.map((column) => `
          <div class="summary-metric-box metric-${escapeAttribute(column.id.replace(/_/g, "-"))}">
            <span class="metric-box-label">${escapeHtml(column.label)}</span>
            <span class="metric-box-value">${summary.total[column.id]}</span>
          </div>`).join("")}
          <div class="summary-metric-box metric-total">
            <span class="metric-box-label">${escapeHtml(t("calendar.summary.items"))}</span>
            <span class="metric-box-value">${summary.total.items}</span>
          </div>
        </div>

        <div class="calendar-summary-table-wrapper">
          <table class="calendar-summary-table">
            <thead>
              <tr>
                <th scope="col">${escapeHtml(t("calendar.summary.section"))}</th>
                ${columns.map((column) => `<th scope="col" class="text-right">${escapeHtml(column.label)}</th>`).join("")}
                <th scope="col" class="text-right">${escapeHtml(t("calendar.summary.items"))}</th>
                <th scope="col" class="text-right">${escapeHtml(t("calendar.summary.events"))}</th>
              </tr>
            </thead>
            <tbody>
              ${summary.rows.map((row) => `
              <tr class="${row.hidden ? "is-hidden-section" : ""}">
                <th scope="row"><span class="cat-pill" data-section="${row.section}"><span aria-hidden="true">${escapeHtml(Sections.byId(row.section).short)}</span> ${escapeHtml(sectionName(row.section))}</span></th>
                ${cells(row.counts, false)}
                <td class="text-right num-val font-semibold">
                  <button type="button" class="calendar-summary-toggle" data-summary-section="${row.section}" aria-pressed="${!row.hidden}" title="${escapeAttribute(t(row.hidden ? "calendar.summary.show" : "calendar.summary.hide", { section: sectionName(row.section) }))}">${row.counts.items}</button>
                </td>
                <td class="text-right num-val">${row.counts.events}</td>
              </tr>`).join("")}
            </tbody>
            <tfoot>
              <tr class="grand-total-row">
                <th scope="row">${escapeHtml(t("calendar.summary.total"))}</th>
                ${cells(summary.total, true)}
                <td class="text-right num-val font-bold highlight-total">${summary.total.items}</td>
                <td class="text-right num-val font-bold">${summary.total.events}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    `;
    elements.calendarSummaryContainer.querySelectorAll("[data-summary-range]").forEach((button) => {
      button.addEventListener("click", () => {
        state.calendarSummaryRange = button.dataset.summaryRange === "all" ? "all" : "range";
        storeCalendarFilters();
        renderCalendarSummary();
      });
    });
    elements.calendarSummaryContainer.querySelectorAll("[data-summary-section]").forEach((button) => {
      button.addEventListener("click", () => toggleCalendarSection(button.dataset.summarySection));
    });
  }

  // ---- opening an event ------------------------------------------------------

  function jumpToCalendarItem(type, id, parentId, parentKind, startupId) {
    if (startupId && startupId !== STARTUP_ID) {
      openRecordInOtherStartup(startupId, type, id);
      return;
    }
    if (type === "pipeline" || type === "marketing") openTargetWindow("mk", id);
    else if (type === "program") openTargetWindow("po", id);
    else if (type === "funding") openTargetWindow("fu", id);
    else if (type === "campaign") openGlobalSearchResult({ type: "campaign", id, matchKind: "" });
    else if (type === "company") showCompanyEntry(parentKind === "deadline" ? "deadline" : "step", parentId || id);
  }

  // Opens a Company entry (a step, a deadline, an obligation or an expense)
  // in the Company tab's window.
  function showCompanyEntry(kind, id) {
    state.selectedAppTab = "company";
    render();
    companyPage()?.show(kind, id);
  }

  function debounce(callback, delay = 150) {
    let timeoutId = null;
    return (...args) => {
      if (timeoutId) window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        timeoutId = null;
        callback(...args);
      }, delay);
    };
  }

  function normalizeGlobalSearchText(value) {
    return String(value ?? "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  function formatGlobalSearchFieldLabel(key) {
    const labels = {
      applicationName: t("app.formatGlobalSearchFieldLabel.application"),
      applicationLink: t("app.formatGlobalSearchFieldLabel.applicationLink"),
      sourceType: t("app.formatGlobalSearchFieldLabel.sourceType"),
      nextAction: t("ui.common.nextAction"),
      nextActionDate: t("ui.common.nextActionDate"),
      nextActionTime: t("app.formatGlobalSearchFieldLabel.nextActionTime"),
      contactName: t("app.formatGlobalSearchFieldLabel.contact"),
      contactRole: t("app.formatGlobalSearchFieldLabel.contactRole"),
      contactEmail: t("app.formatGlobalSearchFieldLabel.contactEmail"),
      targetAmount: t("app.formatGlobalSearchFieldLabel.targetAmount"),
      expectedCloseDate: t("app.formatGlobalSearchFieldLabel.expectedClose"),
      successMetric: t("app.formatGlobalSearchFieldLabel.successMetric"),
      startDate: t("app.formatGlobalSearchFieldLabel.startDate"),
      endDate: t("app.formatGlobalSearchFieldLabel.endDate"),
      customVarExamples: t("app.formatGlobalSearchFieldLabel.examples"),
      externalPath: t("app.formatGlobalSearchFieldLabel.pathUrl"),
      originalName: t("app.formatGlobalSearchFieldLabel.originalFilename"),
      storedName: t("app.formatGlobalSearchFieldLabel.storedFilename"),
      repeatInterval: t("app.formatGlobalSearchFieldLabel.repeatInterval"),
      repeatUnit: t("app.formatGlobalSearchFieldLabel.repeatUnit"),
    };
    if (labels[key]) return labels[key];
    return String(key || t("app.formatGlobalSearchFieldLabel.details"))
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .replace(/^./, (character) => character.toUpperCase());
  }

  function shouldIgnoreGlobalSearchKey(key) {
    const normalizedKey = String(key || "").toLowerCase();
    return GLOBAL_SEARCH_IGNORED_KEYS.has(normalizedKey)
      || normalizedKey.endsWith("id")
      || normalizedKey === "lastopenedat"
      || normalizedKey === "hasrepeated"
      || normalizedKey === "pinned";
  }

  function appendGlobalSearchFields(fields, label, value, kind = "detail", seen = new Set(), depth = 0) {
    if (value === null || value === undefined || depth > 5) return;

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const text = String(value).trim();
      if (!text || /^data:/i.test(text)) return;
      fields.push({
        label: label || t("app.appendGlobalSearchFields.details"),
        value: text.length > GLOBAL_SEARCH_MAX_VALUE_LENGTH ? text.slice(0, GLOBAL_SEARCH_MAX_VALUE_LENGTH) : text,
        kind,
      });
      return;
    }

    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((entry) => appendGlobalSearchFields(fields, label || t("app.appendGlobalSearchFields.details"), entry, kind, seen, depth + 1));
      seen.delete(value);
      return;
    }

    Object.entries(value).forEach(([key, childValue]) => {
      if (shouldIgnoreGlobalSearchKey(key)) return;
      const childLabel = label ? `${label} · ${formatGlobalSearchFieldLabel(key)}` : formatGlobalSearchFieldLabel(key);
      const childKind = ["notes", "note", "description", "outcome", "action", "details", "lessonsLearned", "evidenceFor", "evidenceAgainst", "hostedPain", "mustKeep"].includes(key)
        ? "note"
        : "detail";
      appendGlobalSearchFields(fields, childLabel, childValue, childKind, seen, depth + 1);
    });

    seen.delete(value);
  }

  function buildGlobalSearchFields(record, { titleKeys = [], noteKeys = [] } = {}) {
    const fields = [];
    const titleSet = new Set(titleKeys);
    const noteSet = new Set(noteKeys);
    Object.entries(record || {}).forEach(([key, value]) => {
      if (shouldIgnoreGlobalSearchKey(key)) return;
      const fieldKind = titleSet.has(key) ? "title" : noteSet.has(key) ? "note" : "detail";
      appendGlobalSearchFields(fields, formatGlobalSearchFieldLabel(key), value, fieldKind);
    });
    return fields;
  }

  function findGlobalSearchMatch(fields, queryTerms) {
    const candidates = fields
      .map((field) => {
        const normalizedValue = normalizeGlobalSearchText(field.value);
        if (!normalizedValue) return null;
        const cleanValue = normalizedValue.replace(/[-_:]+/g, " ");
        const normalizedQuery = queryTerms.join(" ");
        const cleanQuery = queryTerms.map((t) => t.replace(/[-_:]+/g, " ").trim()).filter(Boolean).join(" ");
        const cleanTerms = cleanQuery.split(/\s+/).filter(Boolean);

        const matchesStandard = queryTerms.every((term) => normalizedValue.includes(term));
        const matchesClean = cleanTerms.length > 0 && cleanTerms.every((term) => cleanValue.includes(term));
        if (!matchesStandard && !matchesClean) return null;

        const isExact = normalizedValue === normalizedQuery || cleanValue === cleanQuery;
        const startsWith = normalizedValue.startsWith(normalizedQuery) || cleanValue.startsWith(cleanQuery);
        const index = Math.min(
          normalizedValue.indexOf(queryTerms[0]) >= 0 ? normalizedValue.indexOf(queryTerms[0]) : Infinity,
          cleanValue.indexOf(cleanTerms[0] || "") >= 0 ? cleanValue.indexOf(cleanTerms[0] || "") : Infinity
        );
        const safeIndex = Number.isFinite(index) ? index : 0;
        const kindWeight = field.kind === "title" ? 0 : field.kind === "id" ? 5 : field.kind === "note" ? 20 : 40;
        const qualityWeight = isExact ? 0 : startsWith ? 4 : 10;
        return {
          field,
          score: kindWeight + qualityWeight + Math.max(0, safeIndex) / 10000,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score);

    return candidates[0] || null;
  }

  function getGlobalSearchSnippet(value, queryTerms) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (text.length <= 132) return text;

    const normalizedText = normalizeGlobalSearchText(text);
    const matchIndex = normalizedText.indexOf(queryTerms[0] || "");
    const start = matchIndex > 42 ? matchIndex - 42 : 0;
    const end = Math.min(text.length, start + 132);
    return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
  }

  function getGlobalSearchTabKey(type, badge) {
    const badgeUpper = String(badge || "").toUpperCase();
    const typeStr = String(type || "");
    if (typeStr.startsWith("company-") || badgeUpper === "COMP") return "comp";
    if (badgeUpper === "MK" || badgeUpper === "CAT" || typeStr === "target" || typeStr === "category") return "mk";
    if (badgeUpper === "PO" || typeStr === "program") return "po";
    if (badgeUpper === "FU" || typeStr === "funding" || typeStr === "funding-round") return "fu";
    if (badgeUpper === "AI" || typeStr === "ai-account") return "ai";
    if (badgeUpper === "ME" || typeStr === "media") return "me";
    if (badgeUpper === "FB" || typeStr === "feedback") return "fb";
    if (badgeUpper === "CP" || typeStr === "campaign") return "cp";
    if (badgeUpper === "TG" || typeStr === "tag") return "tg";
    if (badgeUpper === "RE" || badgeUpper === "OC" || typeStr === "daily-link") return "re";
    if (badgeUpper === "PR" || typeStr === "prompt") return "pr";
    if (badgeUpper === "CA") return "ca";
    return badgeUpper.toLowerCase() || "default";
  }

  function normalizeGlobalSearchStatusKey(status) {
    return String(status || "").toLowerCase().replace(/[\s_/]+/g, "-");
  }

  function makeGlobalSearchResult(config, queryTerms) {
    const fields = buildGlobalSearchFields(config.record, {
      titleKeys: config.titleKeys,
      noteKeys: config.noteKeys,
    });
    const recordId = String(config.id || config.record?.id || "").trim();
    if (recordId) {
      appendGlobalSearchFields(fields, "ID", recordId, "id");
      const badge = String(config.badge || "").trim().toLowerCase();
      const badgePrefix = `${badge}-`;
      if (badgePrefix.length > 1 && !recordId.toLowerCase().startsWith(badgePrefix)) {
        appendGlobalSearchFields(fields, "ID", `${badgePrefix}${recordId}`, "id");
      }
    }
    appendGlobalSearchFields(fields, t("app.makeGlobalSearchResult.area"), config.section, "detail");
    appendGlobalSearchFields(fields, t("app.makeGlobalSearchResult.recordType"), config.subtitle, "detail");
    if (config.status) {
      appendGlobalSearchFields(fields, t("ui.common.status"), config.status, "detail");
    }
    if (config.date) {
      appendGlobalSearchFields(fields, t("app.makeGlobalSearchResult.date"), config.date, "detail");
    }
    if (config.updatedAt) {
      appendGlobalSearchFields(fields, t("app.makeGlobalSearchResult.updated"), config.updatedAt, "detail");
    }
    (config.extraFields || []).forEach((field) => {
      appendGlobalSearchFields(fields, field.label, field.value, field.kind || "detail");
    });

    const match = findGlobalSearchMatch(fields, queryTerms);
    if (!match) return null;

    return {
      type: config.type,
      id: String(config.id),
      title: String(config.title || t("app.makeGlobalSearchResult.untitled")),
      subtitle: String(config.subtitle || ""),
      section: String(config.section || t("app.makeGlobalSearchResult.app")),
      badge: String(config.badge || "APP"),
      status: String(config.status || ""),
      rawStatus: String(config.rawStatus || config.status || ""),
      date: String(config.date || ""),
      updatedAt: String(config.updatedAt || ""),
      tabKey: config.tabKey || getGlobalSearchTabKey(config.type, config.badge),
      matchLabel: match.field.label,
      matchKind: match.field.kind,
      snippet: match.field.kind === "id" ? String(config.id || match.field.value) : getGlobalSearchSnippet(match.field.value, queryTerms),
      score: match.score,
      companyKind: config.companyKind || "",
    };
  }

  function buildGlobalSearchResults(query) {
    const rawQuery = String(query || "").trim();
    const strippedQuery = rawQuery.replace(/^id:\s*/i, "");
    const normalizedQuery = normalizeGlobalSearchText(strippedQuery).trim();
    if (!normalizedQuery) return [];
    const cacheKey = `${derivedDataRevision}\u0000${normalizedQuery}`;
    if (globalSearchCache && globalSearchCache.key === cacheKey) {
      return globalSearchCache.results.slice();
    }

    const queryTerms = normalizedQuery.split(/\s+/).filter(Boolean);
    const results = [];
    const add = (config) => {
      const result = makeGlobalSearchResult(config, queryTerms);
      if (result) results.push(result);
    };
    const isActive = (record) => record && !record.deletedAt;

    state.items.filter(isActive).forEach((item) => {
      const category = getCategory(item.category);
      const subcategoryNames = (item.subcategories || []).map((id) => Taxonomy.name(id)).filter(Boolean);
      const targetDate = item.date ? (item.time ? `${formatDate(item.date)} ${item.time}` : formatDate(item.date)) : "";
      add({
        type: "target",
        id: item.id,
        title: item.platform,
        subtitle: category?.shortName || t("ui.common.marketing"),
        section: t("ui.common.marketing"),
        badge: "MK",
        record: item,
        status: item.status ? getStatusLabel(item.status) : "",
        rawStatus: item.status || "",
        date: targetDate,
        updatedAt: item.updatedAt ? t("app.buildGlobalSearchResults.updated", { updatedAt: formatShortTimestamp(item.updatedAt) }) : "",
        titleKeys: ["platform"],
        noteKeys: ["notes"],
        extraFields: [
          { label: t("app.buildGlobalSearchResults.category"), value: category?.name || item.category },
          { label: t("app.buildGlobalSearchResults.subcategory"), value: subcategoryNames },
        ],
      });
    });

    state.programs.filter(isActive).forEach((program) => {
      const programDate = program.deadline
        ? t("app.buildGlobalSearchResults.deadline", { deadline: formatDate(program.deadline) })
        : (program.nextActionDate
          ? t("app.buildGlobalSearchResults.next", { nextActionDate: formatDate(program.nextActionDate) })
          : (program.appliedDate ? t("app.buildGlobalSearchResults.applied", { appliedDate: formatDate(program.appliedDate) }) : ""));
      add({
        type: "program",
        id: program.id,
        title: program.name,
        subtitle: t("ui.common.programsOpportunities"),
        section: t("ui.common.programsOpportunities"),
        badge: "PO",
        record: program,
        status: program.status || "",
        rawStatus: program.status || "",
        date: programDate,
        updatedAt: program.updatedAt ? t("app.buildGlobalSearchResults.updated", { updatedAt: formatShortTimestamp(program.updatedAt) }) : "",
        titleKeys: ["name", "applicationName"],
        noteKeys: ["notes"],
        extraFields: [
          { label: t("app.buildGlobalSearchResults.category"), value: getProgramCategoryLabel(program.category) },
          { label: t("app.buildGlobalSearchResults.type"), value: getProgramTypeLabel(program) },
        ],
      });
    });

    state.funding.filter(isActive).forEach((funding) => {
      const fundingDate = funding.expectedCloseDate
        ? t("app.buildGlobalSearchResults.close", { expectedCloseDate: formatDate(funding.expectedCloseDate) })
        : (funding.nextActionDate
          ? t("app.buildGlobalSearchResults.next", { nextActionDate: formatDate(funding.nextActionDate) })
          : (funding.lastContactDate ? t("app.buildGlobalSearchResults.contacted", { lastContactDate: formatDate(funding.lastContactDate) }) : ""));
      add({
        type: "funding",
        id: funding.id,
        title: funding.funder,
        subtitle: funding.opportunity || t("app.buildGlobalSearchResults.fundingOpportunity"),
        section: t("ui.common.funding"),
        badge: "FU",
        record: funding,
        status: funding.status || "",
        rawStatus: funding.status || "",
        date: fundingDate,
        updatedAt: funding.updatedAt ? t("app.buildGlobalSearchResults.updated", { updatedAt: formatShortTimestamp(funding.updatedAt) }) : "",
        titleKeys: ["funder", "opportunity"],
        noteKeys: ["notes", "nextAction", "lossReason"],
        extraFields: [{ label: t("app.buildGlobalSearchResults.category"), value: getFundingCategoryName(funding.category) }],
      });
    });

    state.fundingRounds.filter(isActive).forEach((round) => {
      add({
        type: "funding-round",
        id: round.id,
        title: round.name,
        subtitle: t("app.buildGlobalSearchResults.fundingRound"),
        section: t("ui.common.funding"),
        badge: "FU",
        record: round,
        status: round.stage || "",
        rawStatus: round.stage || "",
        date: round.expectedCloseDate ? t("app.buildGlobalSearchResults.close", { expectedCloseDate: formatDate(round.expectedCloseDate) }) : "",
        updatedAt: round.updatedAt ? t("app.buildGlobalSearchResults.updated", { updatedAt: formatShortTimestamp(round.updatedAt) }) : "",
        titleKeys: ["name", "stage"],
        noteKeys: ["notes"],
      });
    });

    state.campaigns.filter(isActive).forEach((campaign) => {
      const campaignDate = campaign.launchDate
        ? t("app.buildGlobalSearchResults.launch", { launchDate: formatDate(campaign.launchDate) })
        : (campaign.startDate && campaign.endDate
          ? `${formatDate(campaign.startDate)} – ${formatDate(campaign.endDate)}`
          : (campaign.startDate ? t("app.buildGlobalSearchResults.start", { startDate: formatDate(campaign.startDate) }) : ""));
      add({
        type: "campaign",
        id: campaign.id,
        title: campaign.name,
        subtitle: t("ui.common.campaign"),
        section: t("ui.common.campaigns"),
        badge: "CP",
        record: campaign,
        status: campaign.status ? Statuses.campaignStatusLabel(campaign.status) : "",
        rawStatus: campaign.status || "",
        date: campaignDate,
        updatedAt: campaign.updatedAt ? t("app.buildGlobalSearchResults.updated", { updatedAt: formatShortTimestamp(campaign.updatedAt) }) : "",
        titleKeys: ["name"],
        noteKeys: ["description", "hypothesis", "goal", "successMetric"],
      });
    });

    state.dailyLinks.filter(isActive).forEach((link) => {
      add({
        type: "daily-link",
        id: link.id,
        title: link.title,
        subtitle: `${t("app.buildGlobalSearchResults.subtitleResearchLinks")}${link.subcategory ? ` · ${link.subcategory}` : ""}`,
        section: t("app.buildGlobalSearchResults.researchLinks"),
        badge: "RE",
        record: link,
        status: link.active !== false ? t("app.buildGlobalSearchResults.active") : t("app.buildGlobalSearchResults.inactive"),
        rawStatus: link.active !== false ? "active" : "inactive",
        date: link.lastOpenedAt ? t("app.buildGlobalSearchResults.opened", { lastOpenedAt: formatShortTimestamp(link.lastOpenedAt) }) : "",
        updatedAt: link.updatedAt ? t("app.buildGlobalSearchResults.updated", { updatedAt: formatShortTimestamp(link.updatedAt) }) : "",
        titleKeys: ["title"],
        noteKeys: ["description"],
      });
    });

    state.aiAccounts.filter(isActive).forEach((account) => {
      add({
        type: "ai-account",
        id: account.id,
        title: account.name,
        subtitle: `AI${account.kind ? ` · ${account.kind}` : ""}`,
        section: "AI",
        badge: "AI",
        record: account,
        status: "",
        rawStatus: "",
        date: "",
        updatedAt: account.updatedAt ? t("app.buildGlobalSearchResults.updated", { updatedAt: formatShortTimestamp(account.updatedAt) }) : "",
        titleKeys: ["name", "models"],
        noteKeys: ["details"],
      });
    });

    (state.aiFlow || []).filter((flow) => !flow.isSeparator && isActive(flow)).forEach((flow) => {
      add({
        type: "ai-flow",
        id: flow.id,
        title: flow.subApi,
        subtitle: t("app.buildGlobalSearchResults.currentFlow", { model: flow.model }),
        section: "AI",
        badge: t("app.buildGlobalSearchResults.flow"),
        record: flow,
        status: "",
        rawStatus: "",
        date: "",
        updatedAt: "",
        titleKeys: ["subApi", "model"],
        noteKeys: ["details"],
      });
    });

    state.prompts.filter(isActive).forEach((prompt) => {
      add({
        type: "prompt",
        id: prompt.id,
        title: prompt.name || prompt.title || "",
        subtitle: t("app.buildGlobalSearchResults.prompt"),
        section: t("app.buildGlobalSearchResults.prompts"),
        badge: "PR",
        record: prompt,
        status: "",
        rawStatus: "",
        date: "",
        updatedAt: prompt.updatedAt ? t("app.buildGlobalSearchResults.updated", { updatedAt: formatShortTimestamp(prompt.updatedAt) }) : "",
        titleKeys: ["name"],
        noteKeys: ["body"],
      });
    });

    state.feedbackItems.filter(isActive).forEach((item) => {
      const feedbackDate = item.nextActionDate
        ? t("app.buildGlobalSearchResults.next", { nextActionDate: formatDate(item.nextActionDate) })
        : (item.nextReviewDate
          ? t("app.buildGlobalSearchResults.review", { nextReviewDate: formatDate(item.nextReviewDate) })
          : (item.createdAt ? t("app.buildGlobalSearchResults.logged", { createdAt: formatDate(item.createdAt) }) : ""));
      add({
        type: "feedback",
        id: item.id,
        title: item.title,
        subtitle: `${t("app.buildGlobalSearchResults.subtitleFeedback")}${item.type ? ` · ${item.type}` : ""}`,
        section: t("app.buildGlobalSearchResults.feedback"),
        badge: "FB",
        record: item,
        status: item.status ? (item.status.charAt(0).toUpperCase() + item.status.slice(1)) : "",
        rawStatus: item.status || "",
        date: feedbackDate,
        updatedAt: item.updatedAt ? t("app.buildGlobalSearchResults.updated", { updatedAt: formatShortTimestamp(item.updatedAt) }) : "",
        titleKeys: ["title"],
        noteKeys: ["description", "outcome", "action", "hostedPain", "mustKeep", "evidenceFor", "evidenceAgainst"],
      });
    });

    state.mediaItems.filter(isActive).forEach((media) => {
      add({
        type: "media",
        id: media.id,
        title: media.title,
        subtitle: `${t("app.buildGlobalSearchResults.subtitleMedia")}${media.type ? ` · ${media.type}` : ""}`,
        section: t("app.buildGlobalSearchResults.media"),
        badge: "ME",
        record: media,
        status: "",
        rawStatus: "",
        date: media.createdAt ? t("app.buildGlobalSearchResults.added", { createdAt: formatDate(media.createdAt) }) : "",
        updatedAt: media.updatedAt ? t("app.buildGlobalSearchResults.updated", { updatedAt: formatShortTimestamp(media.updatedAt) }) : "",
        titleKeys: ["title", "originalName"],
        noteKeys: ["notes"],
      });
    });

    getAllTagRecords().forEach((tag) => {
      add({
        type: "tag",
        id: tag.id,
        title: `#${tag.label || tag.id}`,
        subtitle: t("app.buildGlobalSearchResults.tagDefinition"),
        section: t("ui.common.tags"),
        badge: "TG",
        record: { label: tag.label || tag.id, description: tag.description || "" },
        status: "",
        rawStatus: "",
        date: "",
        updatedAt: "",
        titleKeys: ["label"],
        noteKeys: ["description"],
      });
    });

    categories.forEach((category) => {
      add({
        type: "category",
        id: category.id,
        title: category.name,
        subtitle: `${t("app.buildGlobalSearchResults.subtitleMarketingCategory")}${category.shortName ? ` · ${category.shortName}` : ""}`,
        section: t("app.buildGlobalSearchResults.marketingSetup"),
        badge: "CAT",
        record: category,
        status: "",
        rawStatus: "",
        date: "",
        updatedAt: "",
        titleKeys: ["name", "shortName"],
        noteKeys: ["description", "contentTypes"],
      });
    });

    // Company: steps, your own obligations, deadlines you noted and expenses.
    const company = currentCompanyView();
    const companyEntry = (type, companyKind, entry, extra) => add({
      type,
      id: entry.id,
      section: t("app.buildGlobalSearchResults.company"),
      badge: "COMP",
      status: entry.status ? getStatusLabel(entry.status) : "",
      rawStatus: entry.status || "",
      updatedAt: entry.record?.updatedAt ? t("app.buildGlobalSearchResults.updated", { updatedAt: formatShortTimestamp(entry.record.updatedAt) }) : "",
      titleKeys: ["title"],
      noteKeys: ["description", "authority", "notes"],
      companyKind,
      ...extra,
    });
    company.steps.forEach((step) => companyEntry("company-step", "step", step, {
      title: step.title,
      subtitle: t("company.search.step"),
      record: step,
      date: step.dueDate ? t("app.buildGlobalSearchResults.due", { dueDate: formatDate(step.dueDate) }) : "",
    }));
    company.obligations.filter((obligation) => obligation.custom || obligation.notes).forEach((obligation) => companyEntry("company-obligation", "obligation", obligation, {
      title: obligation.title,
      subtitle: t("company.search.obligation"),
      record: obligation,
      date: "",
    }));
    company.deadlines.items.filter((deadline) => deadline.record).forEach((deadline) => companyEntry("company-deadline", "deadline", deadline, {
      title: deadline.title,
      subtitle: t("company.search.deadline"),
      record: deadline,
      date: t("app.buildGlobalSearchResults.due", { dueDate: formatDate(deadline.dueDate) }),
    }));
    state.companyExpenses.filter(isActive).forEach((expense) => companyEntry("company-expense", "expense", { ...expense, status: "" }, {
      title: expense.title || t("company.expenses.untitled"),
      subtitle: t("company.search.expense"),
      record: expense,
      date: expense.date ? formatDate(expense.date) : "",
    }));

    const sortedResults = results
      .sort((a, b) => a.score - b.score || a.title.localeCompare(b.title))
      .slice(0, GLOBAL_SEARCH_LIMIT);
    globalSearchCache = { key: cacheKey, results: sortedResults };
    return sortedResults.slice();
  }

  // ---- This startup / All startups -------------------------------------
  // Search and the calendar can read every open startup through the read-only
  // /api/all routes. Opening something from another startup loads that
  // startup's page (with ?open=<type>:<id>), so its edits go through its own
  // outbox, never this page's.
  const ALL_SEARCH_LIMIT = 50;
  const ALL_CALENDAR_MAX_AGE_MS = 60_000;
  const ALL_SEARCH_KINDS = {
    marketing: { type: "target", badge: "MK", group: "marketing", calendarType: "pipeline" },
    program: { type: "program", badge: "PO", group: "programs", calendarType: "program" },
    funding: { type: "funding", badge: "FU", group: "funding", calendarType: "funding" },
    campaign: { type: "campaign", badge: "CP" },
    media: { type: "media", badge: "ME" },
  };
  // Record types that ?open= may name, and the collection each lives in.
  const OPENABLE_RECORD_TYPES = {
    target: () => state.items,
    pipeline: () => state.items,
    program: () => state.programs,
    funding: () => state.funding,
    campaign: () => state.campaigns,
    media: () => state.mediaItems,
  };

  // The scope picked in this startup, or the default from Settings > General
  // while none was picked here.
  function readStoredScope(key) {
    const stored = readStoredScopeChoice(key);
    return stored || Settings.defaultScopeChoice(Settings.get());
  }

  function readStoredScopeChoice(key) {
    try {
      const value = key ? localStorage.getItem(key) : null;
      return value === SCOPE_ALL || value === SCOPE_THIS ? value : "";
    } catch {
      return "";
    }
  }

  function writeStoredScope(key, scope) {
    try {
      if (key) localStorage.setItem(key, scope);
    } catch {
      // Storage can be blocked; the choice then lasts for this page only.
    }
  }

  // Rows per page of the MK, PO and FU target tables start at the size set
  // in Settings > General. A size picked on a page wins (js/section-page.js).
  function applyDefaultPageSize(size) {
    Object.values(sectionPages).forEach((page) => page.setDefaultPageSize(size));
  }

  // A change in Settings shows at once: dates, the time zone, the week start,
  // the default scopes and page sizes.
  function applySettingsToPage(settings, previous) {
    formattedDateCache.clear();
    formattedTimestampCache.clear();
    formattedShortTimestampCache.clear();
    if (!readStoredScopeChoice(SEARCH_SCOPE_STORAGE_KEY)) state.searchScope = Settings.defaultScopeChoice(settings);
    if (!readStoredScopeChoice(CALENDAR_SCOPE_STORAGE_KEY)) state.calendarScope = Settings.defaultScopeChoice(settings);
    applyDefaultPageSize(settings.pageSize);
    calendarEventsCache = null;
    render();
  }

  function renderScopeSwitch(buttons, attribute, scope) {
    (buttons || []).forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset[attribute] === scope));
    });
  }

  function currentStartupLabel() {
    const startup = window.StartupTrackerStartups?.current?.();
    return { id: STARTUP_ID, name: startup?.name || STARTUP_ID, icon: startup?.icon || "" };
  }

  function renderStartupChip(startup) {
    if (!startup) return "";
    const icon = /^data:image\/[a-z0-9.+-]+;base64,/i.test(String(startup.icon || "")) ? startup.icon : "";
    return `<span class="startup-chip">${icon ? `<img class="startup-chip-icon" src="${escapeAttribute(icon)}" alt="">` : ""}<span class="startup-chip-name">${escapeHtml(startup.name || startup.id || "")}</span></span>`;
  }

  // Saves the edit in progress into this startup's outbox before the page
  // goes away. The browser's unload flush does the same, but waiting here
  // lets the cache write finish first.
  async function prepareToLeave() {
    flushAutosave();
    const pending = activePersistPromise;
    if (!pending) return;
    await Promise.race([
      Promise.resolve(pending).catch(() => {}),
      new Promise((resolve) => window.setTimeout(resolve, 1500)),
    ]);
  }

  async function openRecordInOtherStartup(startupId, type, id) {
    if (!Api.isStartupId(startupId) || startupId === STARTUP_ID) return false;
    await prepareToLeave();
    window.location.assign(Api.pageUrl(startupId, { open: `${type}:${id}` }));
    return true;
  }

  // Opens the record named by ?open=<type>:<id> once the state is loaded, and
  // takes the parameter out of the address so a reload does not reopen it.
  function openRecordFromAddress() {
    const params = new URLSearchParams(window.location.search);
    const target = params.get("open");
    if (!target) return;
    params.delete("open");
    const search = params.toString();
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`);
    const separator = target.indexOf(":");
    if (separator < 1) return;
    const type = target.slice(0, separator);
    const id = target.slice(separator + 1);
    const collection = Object.hasOwn(OPENABLE_RECORD_TYPES, type) ? OPENABLE_RECORD_TYPES[type]() : null;
    if (!Array.isArray(collection) || !collection.some((record) => record && String(record.id) === id)) return;
    if (type === "pipeline") {
      jumpToCalendarItem("pipeline", id);
      return;
    }
    openGlobalSearchResult({ type, id, matchKind: "" });
  }

  function setSearchScope(scope) {
    const next = scope === SCOPE_ALL ? SCOPE_ALL : SCOPE_THIS;
    if (state.searchScope === next) return;
    state.searchScope = next;
    writeStoredScope(SEARCH_SCOPE_STORAGE_KEY, next);
    renderGlobalSearch();
  }

  let allSearchToken = 0;

  async function loadAllStartupsSearch(query) {
    const token = ++allSearchToken;
    state.allSearch = { query, results: [], truncated: false, loading: true, failed: false };
    try {
      const response = await fetch(Api.urls.allSearch(query, ALL_SEARCH_LIMIT), { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (token !== allSearchToken) return;
      state.allSearch = {
        query,
        results: Array.isArray(payload.results) ? payload.results : [],
        truncated: payload.truncated === true,
        loading: false,
        failed: false,
      };
    } catch {
      if (token !== allSearchToken) return;
      state.allSearch = { query, results: [], truncated: false, loading: false, failed: true };
    }
    renderGlobalSearch();
  }

  function renderAllStartupsSearch(query) {
    const trimmed = String(query || "").trim();
    if (state.allSearch.query !== trimmed) {
      loadAllStartupsSearch(trimmed);
    }
    const { results, loading, failed, truncated } = state.allSearch;
    if (loading) {
      elements.globalSearchList.innerHTML = `<div class="global-search-empty" role="status">${escapeHtml(t("search.loadingAll"))}</div>`;
      return;
    }
    if (failed) {
      elements.globalSearchList.innerHTML = `<div class="global-search-empty" role="alert">${escapeHtml(t("search.failedAll"))}</div>`;
      return;
    }
    if (!results.length) {
      elements.globalSearchList.innerHTML = `<div class="global-search-empty">${escapeHtml(t("search.noMatches"))}</div>`;
      return;
    }
    const rows = results.map((result, index) => {
      const kind = ALL_SEARCH_KINDS[result.kind] || {};
      const statusKey = normalizeGlobalSearchStatusKey(result.status);
      return `
      <button class="global-search-result" type="button" role="option" data-all-search-index="${index}">
        <span class="global-search-result-type"${kind.group ? ` data-section="${Sections.byGroup(kind.group).id}"` : ""}>${escapeHtml(kind.badge || String(result.kind || "").slice(0, 2).toUpperCase())}</span>
        <span class="global-search-result-main">
          <span class="global-search-result-title">${escapeHtml(result.title || result.id)}</span>
          ${result.status ? `<span class="global-search-result-info"><span class="global-search-result-status" data-status="${escapeAttribute(result.status)}" data-status-key="${escapeAttribute(statusKey)}">${escapeHtml(result.status)}</span></span>` : ""}
          <span class="global-search-result-meta">${renderStartupChip(result.startup)}<span>${escapeHtml(kind.badge ? t(`search.kinds.${result.kind}`) : String(result.kind || ""))}</span></span>
        </span>
      </button>
    `;
    }).join("");
    const note = truncated
      ? `<div class="global-search-empty">${escapeHtml(t("search.truncated", { count: results.length }))}</div>`
      : "";
    elements.globalSearchList.innerHTML = rows + note;
  }

  function openAllStartupsSearchResult(result) {
    const kind = result ? ALL_SEARCH_KINDS[result.kind] : null;
    if (!kind) return;
    if (result.startup?.id && result.startup.id !== STARTUP_ID) {
      if (!prepareGlobalSearchNavigation()) return;
      clearGlobalSearch();
      openRecordInOtherStartup(result.startup.id, kind.type, result.id);
      return;
    }
    openGlobalSearchResult({ type: kind.type, id: String(result.id), matchKind: "" });
  }

  function setCalendarScope(scope) {
    const next = scope === SCOPE_ALL ? SCOPE_ALL : SCOPE_THIS;
    if (state.calendarScope === next) return;
    state.calendarScope = next;
    writeStoredScope(CALENDAR_SCOPE_STORAGE_KEY, next);
    render();
  }

  // The other startups' dates, all of them: "Due by" needs everything before
  // the chosen day. Re-read when older than a minute.
  async function ensureAllStartupsCalendar() {
    const calendar = state.allCalendar;
    if (calendar.loading || (calendar.loadedAt && Date.now() - calendar.loadedAt < ALL_CALENDAR_MAX_AGE_MS)) return;
    state.allCalendar = { ...calendar, loading: true, failed: false };
    try {
      const response = await fetch(Api.urls.allCalendar(), { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      state.allCalendar = {
        events: Array.isArray(payload.events) ? payload.events : [],
        records: Array.isArray(payload.records) ? payload.records : [],
        loadedAt: Date.now(),
        loading: false,
        failed: false,
      };
    } catch {
      state.allCalendar = { ...state.allCalendar, loadedAt: Date.now(), loading: false, failed: true };
    }
    if (state.calendarScope === SCOPE_ALL) renderCalendarTab();
  }

  function renderCalendarScope() {
    renderScopeSwitch(elements.calendarScopeButtons, "calendarScope", state.calendarScope);
    const status = elements.calendarScopeStatus;
    if (!status) return;
    let message = "";
    if (state.calendarScope === SCOPE_ALL) {
      if (state.allCalendar.loading && !state.allCalendar.events.length) message = t("calendar.allLoading");
      else if (state.allCalendar.failed) message = t("calendar.allFailed");
    }
    status.textContent = message;
    status.hidden = !message;
  }

  let combinedCalendarCache = null;

  // This startup's own dates come from the page's state, so edits show at
  // once; the other startups' come from /api/all/calendar. "Due by" keeps
  // only the other startups' open records.
  function combineCalendarEventGroups(mode, localGroups) {
    const remote = state.allCalendar;
    if (
      combinedCalendarCache
      && combinedCalendarCache.local === localGroups
      && combinedCalendarCache.loadedAt === remote.loadedAt
      && combinedCalendarCache.events === remote.events
    ) {
      return combinedCalendarCache.groups;
    }
    const own = currentStartupLabel();
    const groups = Object.fromEntries(CALENDAR_GROUP_KEYS.map((key) => [key, (localGroups[key] || []).map((event) => ({ ...event, startup: own }))]));
    remote.events.forEach((event) => {
      if (!event?.startup?.id || event.startup.id === STARTUP_ID || !event.date) return;
      if (mode === "by" && event.section !== "campaign" && !Statuses.isOpen(event.status)) return;
      groups[calendarGroupKey(event.section)].push({
        ...event,
        id: String(event.id),
        label: String(event.label || event.id),
        type: calendarEventType(event.section),
      });
    });
    sortCalendarGroups(groups);
    combinedCalendarCache = { local: localGroups, loadedAt: remote.loadedAt, events: remote.events, mode, groups };
    return groups;
  }

  // Search results of a section carry its colour.
  function resultSectionAttribute(result) {
    const section = Sections.byTab(result.tabKey || getGlobalSearchTabKey(result.type, result.badge));
    return section ? ` data-section="${section.id}"` : "";
  }

  function renderGlobalSearch() {
    if (!elements.globalSearchInput || !elements.globalSearchResults || !elements.globalSearchList) return;

    const query = String(state.globalSearchQuery || "");
    const isExpanded = Boolean(state.globalSearchExpanded);
    elements.globalSearch?.classList.toggle("expanded", isExpanded);
    if (elements.globalSearchToggle) {
      elements.globalSearchToggle.setAttribute("aria-expanded", String(isExpanded));
      elements.globalSearchToggle.setAttribute("aria-label", isExpanded ? t("app.renderGlobalSearch.closeSearch") : t("app.renderGlobalSearch.openSearch"));
      elements.globalSearchToggle.dataset.tooltip = isExpanded ? t("app.renderGlobalSearch.closeSearch") : t("app.renderGlobalSearch.searchEverything");
    }
    if (elements.globalSearchInput.value !== query) {
      elements.globalSearchInput.value = query;
    }

    const shouldShow = isExpanded && state.globalSearchOpen && query.trim().length > 0;
    elements.globalSearchResults.hidden = !shouldShow;
    elements.globalSearchInput.setAttribute("aria-expanded", String(shouldShow));
    renderScopeSwitch(elements.searchScopeButtons, "searchScope", state.searchScope);
    if (!shouldShow) {
      elements.globalSearchList.innerHTML = "";
      return;
    }

    if (state.searchScope === SCOPE_ALL) {
      renderAllStartupsSearch(query);
      return;
    }

    const results = buildGlobalSearchResults(query);
    if (!results.length) {
      elements.globalSearchList.innerHTML = `<div class="global-search-empty">${escapeHtml(t("search.noMatches"))}</div>`;
      return;
    }

    elements.globalSearchList.innerHTML = results.map((result) => {
      const statusKey = normalizeGlobalSearchStatusKey(result.rawStatus || result.status);
      const hasInfoRow = Boolean(result.status || result.date || result.updatedAt);
      return `
      <button
        class="global-search-result"
        type="button"
        role="option"
        data-global-search-type="${escapeAttribute(result.type)}"
        data-global-search-id="${escapeAttribute(result.id)}"
        data-global-search-tab="${escapeAttribute(result.tabKey || getGlobalSearchTabKey(result.type, result.badge))}"
      >
        <span class="global-search-result-type"${resultSectionAttribute(result)}>${escapeHtml(result.badge)}</span>
        <span class="global-search-result-main">
          <span class="global-search-result-title">${escapeHtml(result.title)}</span>
          ${hasInfoRow ? `
            <span class="global-search-result-info">
              ${result.status ? `<span class="global-search-result-status" data-status="${escapeAttribute(result.rawStatus || result.status)}" data-status-key="${escapeAttribute(statusKey)}">${escapeHtml(result.status)}</span>` : ""}
              ${result.date ? `<span class="global-search-result-date"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>${escapeHtml(result.date)}</span>` : ""}
              ${result.updatedAt ? `<span class="global-search-result-updated" title="${escapeAttribute(t("app.renderGlobalSearch.lastUpdated"))}"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>${escapeHtml(result.updatedAt)}</span>` : ""}
            </span>
          ` : ""}
          <span class="global-search-result-meta">${escapeHtml(result.section)} · ${escapeHtml(result.matchLabel)}</span>
          <span class="global-search-result-snippet">${escapeHtml(result.snippet || result.subtitle)}</span>
        </span>
      </button>
    `;
    }).join("");
  }

  function isProjectLinksMenuOpen() {
    return Boolean(elements.projectLinksMenu && !elements.projectLinksMenu.hidden);
  }

  function toggleProjectLinksMenu(force) {
    if (!elements.projectLinksDropdown || !elements.projectLinksToggle || !elements.projectLinksMenu) return;
    const shouldOpen = typeof force === "boolean" ? force : elements.projectLinksMenu.hidden;
    if (shouldOpen) {
      if (state.globalSearchExpanded || state.globalSearchOpen) {
        clearGlobalSearch();
      }
      elements.projectLinksMenu.hidden = false;
      elements.projectLinksDropdown.classList.add("open");
      elements.projectLinksToggle.setAttribute("aria-expanded", "true");
    } else {
      elements.projectLinksMenu.hidden = true;
      elements.projectLinksDropdown.classList.remove("open");
      elements.projectLinksToggle.setAttribute("aria-expanded", "false");
    }
  }

  function closeProjectLinksMenu() {
    toggleProjectLinksMenu(false);
  }

  // The top-bar Links menu: the startup profile's links (Settings > Startup
  // profile, or the setup), each with its type's icon. Only http(s), mailto
  // and tel addresses become links.
  function renderProjectLinksMenu() {
    if (!elements.projectLinksMenu) return;
    const links = LinkTypes.normalizeLinks(state.profile?.links)
      .map((link) => ({ ...link, href: LinkTypes.safeHref(link.url) }))
      .filter((link) => link.href);
    const html = links.length
      ? links.map((link) => {
        const type = LinkTypes.typeById(link.type);
        const label = link.label || t(`linkTypes.types.${type.id}`);
        const external = /^https?:/i.test(link.href);
        return `<a class="project-link-item" role="menuitem" href="${escapeAttribute(link.href)}" title="${escapeAttribute(link.url)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>
          <span class="project-link-icon-wrap" aria-hidden="true"><svg><use href="#icon-${escapeAttribute(type.icon)}"></use></svg></span>
          <span class="project-link-text">${escapeHtml(label)}</span>
        </a>`;
      }).join("")
      : `<span class="project-link-item project-links-empty" role="menuitem" aria-disabled="true"><span class="project-link-text">${escapeHtml(t("ui.topbar.noLinksYet"))}</span></span>`;
    if (renderProjectLinksMenu.last === html) return;
    renderProjectLinksMenu.last = html;
    elements.projectLinksMenu.innerHTML = html;
  }

  function clearGlobalSearch() {
    state.globalSearchQuery = "";
    state.globalSearchOpen = false;
    state.globalSearchExpanded = false;
    renderGlobalSearch();
  }

  function prepareGlobalSearchNavigation() {
    if (isModalOpen(elements.mediaDocumentModal) && !requestCloseMediaDocumentModal()) return false;
    return RecordWindow.requestClose();
  }

  function navigateToDailyLinkFromGlobalSearch(id) {
    const link = findDailyLink(id);
    if (!link) return;
    state.selectedAppTab = "extra";
    state.selectedExtraSubTab = "research";
    state.editingDailyLinkId = link.id;
    render();
    flashElement(`[data-daily-id="${cssEscape(link.id)}"]`);
  }

  function navigateToAiAccountFromGlobalSearch(id) {
    const account = findAiAccount(id);
    if (!account) return;
    state.selectedAppTab = "extra";
    state.selectedExtraSubTab = "ai";
    state.editingAiAccountId = account.id;
    render();
    flashElement(`[data-ai-id="${cssEscape(account.id)}"]`);
  }

  function navigateToPromptFromGlobalSearch(id) {
    const prompt = state.prompts.find((entry) => entry.id === id);
    if (!prompt) return;
    state.selectedAppTab = "extra";
    state.selectedExtraSubTab = "prompts";
    const page = promptsPage();
    if (page) page.ui.promptId = prompt.id;
    render();
  }

  function openGlobalSearchResult(result) {
    if (!result || !prepareGlobalSearchNavigation()) return;

    clearGlobalSearch();

    if (result.type === "target") {
      const item = findItem(result.id);
      if (!item) return;
      openTargetForEditing(item.id, { openNotes: true });
      return;
    }

    if (result.type === "program") {
      state.selectedAppTab = "programs";
      render();
      openProgramModal(result.id, result.matchKind === "note" ? "preview" : "core");
      return;
    }

    if (result.type === "funding") {
      state.selectedAppTab = "funding";
      render();
      openFundingModal(result.id, result.matchKind === "note" ? "preview" : "core");
      return;
    }

    if (result.type === "funding-round") {
      state.selectedAppTab = "funding";
      state.selectedFundingRound = result.id;
      render();
      flashElement(`[data-round-id="${cssEscape(result.id)}"]`);
      return;
    }

    if (result.type === "campaign") {
      navigateToCampaign(result.id);
      return;
    }

    if (result.type === "daily-link") {
      navigateToDailyLinkFromGlobalSearch(result.id);
      return;
    }

    if (result.type === "ai-account") {
      navigateToAiAccountFromGlobalSearch(result.id);
      return;
    }

    if (result.type === "prompt") {
      navigateToPromptFromGlobalSearch(result.id);
      return;
    }

    if (result.type === "feedback") {
      navigateToFeedback(result.id, { edit: true });
      return;
    }

    if (result.type === "media") {
      openMediaForEditing(result.id);
      return;
    }

    if (result.type === "tag") {
      navigateToTag(result.id);
      return;
    }

    if (result.type === "category") {
      state.selectedAppTab = "pipeline";
      state.selectedCategory = result.id;
      state.selectedSubcategory = "all";
      state.selectedMkType = "all";
      state.search = "";
      render();
      flashElement(`[data-taxonomy-tab="${cssEscape(result.id)}"]`);
      return;
    }

    if (result.type.startsWith("company-")) {
      showCompanyEntry(result.companyKind, result.id);
    }
  }

  function bindEvents() {
    initAllHorizontalScrollContainers();
    initOverlayStacking();
    bindRecordHistoryPanes();

    // The conflict prompt lives inside the save-state badge and is rebuilt each
    // time it is shown, so its Review button is handled by delegation.
    elements.saveStateLabel?.addEventListener("click", (event) => {
      const action = event.target.closest?.("[data-conflict-action]")?.dataset.conflictAction;
      if (!action) return;
      event.preventDefault();
      if (action === "review") openRecordConflictModal();
    });
    elements.closeRecordConflictModal?.addEventListener("click", closeRecordConflictModal);
    elements.cancelRecordConflictModal?.addEventListener("click", closeRecordConflictModal);
    elements.recordConflictModal?.addEventListener("click", (event) => {
      if (event.target === elements.recordConflictModal) closeRecordConflictModal();
    });
    elements.recordConflictModal?.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const controls = [...elements.recordConflictModal.querySelectorAll(
        "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      )].filter((element) => element.offsetParent !== null);
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    elements.keepMineConflictButton?.addEventListener("click", resolveRecordConflictsKeepingMine);
    elements.useTheirsConflictButton?.addEventListener("click", resolveRecordConflictsUsingTheirs);

    const renderMediaAfterSearchInput = debounce(render);
    const renderCampaignsAfterSearchInput = debounce(render);
    const renderTagsAfterSearchInput = debounce(render);
    const renderGlobalSearchAfterInput = debounce(() => renderGlobalSearch(), GLOBAL_SEARCH_DELAY);

    // Dynamic auto-resizing of textareas to fit content (max 15 lines via CSS max-height: 24em)
    const resizeObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const textareas = node.querySelectorAll ? node.querySelectorAll("textarea") : [];
            textareas.forEach((ta) => {
              if (ta.style.position !== "fixed") {
                autoResizeTextarea(ta);
              }
            });
            if (node.tagName === "TEXTAREA" && node.style.position !== "fixed") {
              autoResizeTextarea(node);
            }
          }
        });
      });
    });
    resizeObserver.observe(document.body, { childList: true, subtree: true });

    document.addEventListener("input", (event) => {
      if (event.target && event.target.tagName === "TEXTAREA" && event.target.style.position !== "fixed") {
        autoResizeTextarea(event.target);
      }
    });

    // Also run on any pre-existing textareas
    setTimeout(() => {
      document.querySelectorAll("textarea").forEach((ta) => {
        if (ta.style.position !== "fixed") {
          autoResizeTextarea(ta);
        }
      });
    }, 0);

    bindExtraSubnav();

    if (elements.projectLinksToggle) {
      elements.projectLinksToggle.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleProjectLinksMenu();
      });
    }

    if (elements.projectLinksMenu) {
      elements.projectLinksMenu.addEventListener("click", (e) => {
        if (e.target.closest("a")) {
          closeProjectLinksMenu();
        }
      });
    }

    document.addEventListener("click", (event) => {
      if (elements.projectLinksDropdown && !elements.projectLinksDropdown.contains(event.target)) {
        if (isProjectLinksMenuOpen()) {
          closeProjectLinksMenu();
        }
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (isProjectLinksMenuOpen()) {
          closeProjectLinksMenu();
          elements.projectLinksToggle?.focus();
        }
      }
    });

    if (elements.globalSearchToggle) {
      elements.globalSearchToggle.addEventListener("click", (e) => {
        e.preventDefault();
        closeProjectLinksMenu();
        if (state.globalSearchExpanded && !state.globalSearchQuery.trim()) {
          clearGlobalSearch();
          return;
        }
        state.globalSearchExpanded = true;
        renderGlobalSearch();
        const focusInput = () => {
          if (elements.globalSearchInput) {
            elements.globalSearchInput.focus({ preventScroll: true });
            if (typeof elements.globalSearchInput.select === "function") {
              elements.globalSearchInput.select();
            }
          }
        };
        focusInput();
        setTimeout(focusInput, 50);
        setTimeout(focusInput, 150);
      });
    }

    if (elements.globalSearchInput) {
      elements.globalSearchInput.addEventListener("input", () => {
        state.globalSearchExpanded = true;
        state.globalSearchQuery = elements.globalSearchInput.value;
        state.globalSearchOpen = Boolean(state.globalSearchQuery.trim());
        if (!state.globalSearchOpen) {
          renderGlobalSearch();
        } else {
          renderGlobalSearchAfterInput();
        }
      });
      elements.globalSearchInput.addEventListener("focus", () => {
        state.globalSearchExpanded = true;
        if (state.globalSearchQuery.trim()) {
          state.globalSearchOpen = true;
          renderGlobalSearch();
        }
      });
      elements.globalSearchInput.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          clearGlobalSearch();
          return;
        }
        if (event.key === "Enter" && state.globalSearchOpen && state.searchScope === SCOPE_ALL) {
          const firstAllResult = state.allSearch.query === state.globalSearchQuery.trim() ? state.allSearch.results[0] : null;
          if (firstAllResult) {
            event.preventDefault();
            openAllStartupsSearchResult(firstAllResult);
          }
          return;
        }
        if (event.key === "Enter" && state.globalSearchOpen) {
          const firstResult = buildGlobalSearchResults(state.globalSearchQuery)[0];
          if (firstResult) {
            event.preventDefault();
            openGlobalSearchResult(firstResult);
          }
        }
      });
    }
    elements.searchScopeButtons.forEach((button) => {
      button.addEventListener("click", () => setSearchScope(button.dataset.searchScope));
    });
    elements.calendarScopeButtons.forEach((button) => {
      button.addEventListener("click", () => setCalendarScope(button.dataset.calendarScope));
    });
    if (elements.globalSearchList) {
      elements.globalSearchList.addEventListener("click", (event) => {
        const allResultButton = event.target.closest("[data-all-search-index]");
        if (allResultButton) {
          openAllStartupsSearchResult(state.allSearch.results[Number(allResultButton.dataset.allSearchIndex)]);
          return;
        }
        const resultButton = event.target.closest("[data-global-search-type]");
        if (!resultButton) return;
        const result = buildGlobalSearchResults(state.globalSearchQuery).find((entry) => (
          entry.type === resultButton.dataset.globalSearchType
          && entry.id === resultButton.dataset.globalSearchId
        ));
        openGlobalSearchResult(result);
      });
    }
    if (elements.globalSearch) {
      document.addEventListener("click", (event) => {
        if (!elements.globalSearch.contains(event.target) && (state.globalSearchExpanded || state.globalSearchOpen)) {
          clearGlobalSearch();
        }
      });
    }

    elements.appTabs.addEventListener("click", (event) => {
      const button = event.target.closest("[data-app-tab]");
      if (!button) return;
      state.selectedAppTab = button.dataset.appTab || "calendar";
      render();
      window.scrollTo({ top: 0, left: 0 });
    });


    if (elements.calendarPrevWeek) {
      elements.calendarPrevWeek.addEventListener("click", () => {
        state.calendarCenterDate = shiftDateISO(state.calendarCenterDate, -9);
        state.calendarSelectedDate = state.calendarCenterDate;
        render();
      });
    }
    if (elements.calendarPrevDay) {
      elements.calendarPrevDay.addEventListener("click", () => {
        state.calendarCenterDate = shiftDateISO(state.calendarCenterDate, -1);
        state.calendarSelectedDate = state.calendarCenterDate;
        render();
      });
    }
    if (elements.calendarNextDay) {
      elements.calendarNextDay.addEventListener("click", () => {
        state.calendarCenterDate = shiftDateISO(state.calendarCenterDate, 1);
        state.calendarSelectedDate = state.calendarCenterDate;
        render();
      });
    }
    if (elements.calendarNextWeek) {
      elements.calendarNextWeek.addEventListener("click", () => {
        state.calendarCenterDate = shiftDateISO(state.calendarCenterDate, 9);
        state.calendarSelectedDate = state.calendarCenterDate;
        render();
      });
    }
    if (elements.calendarTodayBtn) {
      elements.calendarTodayBtn.addEventListener("click", () => {
        state.calendarCenterDate = todayDate();
        state.calendarSelectedDate = todayDate();
        state.calendarMonthAnchor = calendarMonthOf(state.calendarSelectedDate);
        render();
      });
    }

    if (elements.calendarMonthToggle) {
      elements.calendarMonthToggle.addEventListener("click", () => {
        if (!state.calendarMonthOpen) {
          state.calendarMonthAnchor = calendarMonthOf(state.calendarSelectedDate);
        }
        setCalendarMonthOpen(!state.calendarMonthOpen);
        render();
      });
    }
    const shiftCalendarMonth = (months) => {
      const anchor = state.calendarMonthAnchor || calendarMonthOf(state.calendarSelectedDate);
      state.calendarMonthAnchor = calendarMonthOf(Dates.addMonths(anchor, months));
      render();
    };
    elements.calendarMonthPrevMonth?.addEventListener("click", () => shiftCalendarMonth(-1));
    elements.calendarMonthNextMonth?.addEventListener("click", () => shiftCalendarMonth(1));

    if (elements.calendarStripViewport) {
      let isMouseDown = false;
      let startX = 0;
      let scrollLeft = 0;

      elements.calendarStripViewport.addEventListener("mousedown", (e) => {
        isMouseDown = true;
        startX = e.pageX - elements.calendarStripViewport.offsetLeft;
        scrollLeft = elements.calendarStripViewport.scrollLeft;
      });

      window.addEventListener("mouseup", () => {
        isMouseDown = false;
      });

      elements.calendarStripViewport.addEventListener("mousemove", (e) => {
        if (!isMouseDown) return;
        const x = e.pageX - elements.calendarStripViewport.offsetLeft;
        const walk = (x - startX);
        if (Math.abs(walk) > 3) {
          elements.calendarStripViewport.scrollLeft = scrollLeft - walk;
        }
      });
    }

    document.addEventListener("keydown", (e) => {
      if (state.selectedAppTab !== "calendar") return;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        const step = e.shiftKey ? -9 : -1;
        state.calendarCenterDate = shiftDateISO(state.calendarCenterDate, step);
        state.calendarSelectedDate = state.calendarCenterDate;
        render();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        const step = e.shiftKey ? 9 : 1;
        state.calendarCenterDate = shiftDateISO(state.calendarCenterDate, step);
        state.calendarSelectedDate = state.calendarCenterDate;
        render();
      }
    });

    elements.calendarModeButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        state.calendarDateMode = btn.dataset.calendarMode === "by" ? "by" : "on";
        render();
      });
    });

    elements.campaignForm.addEventListener("submit", handleCampaignFormSubmit);
    elements.resetCampaignFormButton.addEventListener("click", resetCampaignForm);
    if (elements.tagForm) {
      elements.tagForm.addEventListener("submit", handleTagFormSubmit);
      elements.tagColorInput?.addEventListener("input", () => {
        elements.tagColorInput.dataset.touched = "1";
      });
    }
    if (elements.resetTagFormButton) {
      elements.resetTagFormButton.addEventListener("click", resetTagForm);
    }
    elements.dailyForm.addEventListener("submit", handleDailyFormSubmit);
    elements.resetDailyFormButton.addEventListener("click", resetDailyForm);
    elements.feedbackForm.addEventListener("submit", handleFeedbackFormSubmit);
    elements.resetFeedbackFormButton.addEventListener("click", resetFeedbackForm);

    // Toggle the strategy sub-block on the add form as the Type changes.
    if (elements.feedbackTypeInput) {
      elements.feedbackTypeInput.addEventListener("change", renderFeedbackFormBlock);
    }

    // Close open filter groups when clicking outside them
    document.addEventListener("click", (e) => {
      const clickedGroup = e.target.closest(".manager-focus-filter-group");
      document.querySelectorAll(".manager-focus-filter-group[open]").forEach((details) => {
        if (details !== clickedGroup) {
          details.removeAttribute("open");
        }
      });

      // Auto-focus search fields on click
      const searchField = e.target.closest(".search-field, [data-search-field]");
      if (searchField) {
        const input = searchField.querySelector("input[type='search'], input[type='text'], input");
        if (input) {
          setTimeout(() => {
            input.focus();
            if (input.value && typeof input.select === "function") {
              input.select();
            }
          }, 0);
        }
      } else if (e.target.matches && e.target.matches("input[type='search']")) {
        const input = e.target;
        setTimeout(() => {
          input.focus();
          if (input.value && typeof input.select === "function") {
            input.select();
          }
        }, 0);
      }
    });

    // Global keyboard shortcut to focus main search: '/' or 'Ctrl+K' / 'Cmd+K'
    document.addEventListener("keydown", (e) => {
      if ((e.key === "/" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) &&
          !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) {
        e.preventDefault();
        state.globalSearchExpanded = true;
        renderGlobalSearch();
        const focusGlobal = () => {
          if (elements.globalSearchInput) {
            elements.globalSearchInput.focus({ preventScroll: true });
            if (typeof elements.globalSearchInput.select === "function") {
              elements.globalSearchInput.select();
            }
          }
        };
        focusGlobal();
        setTimeout(focusGlobal, 50);
      }
    });
    elements.mediaForm.addEventListener("submit", handleMediaFormSubmit);
    elements.resetMediaFormButton.addEventListener("click", resetMediaForm);
    elements.mediaSourceInput.addEventListener("change", updateMediaSourceMode);

    // Panel collapse toggles
    [
      { toggleId: "formPanelToggle", panel: "form" },
      { toggleId: "tablePanelToggle", panel: "table" },
      { toggleId: "programFormPanelToggle", panel: "program-form" },
      { toggleId: "programTablePanelToggle", panel: "program-table" },
      { toggleId: "fundingFormPanelToggle", panel: "funding-form" },
      { toggleId: "fundingRoundsPanelToggle", panel: "funding-rounds" },
      { toggleId: "fundingTablePanelToggle", panel: "funding-table" },
      { toggleId: "focusPanelToggle", panel: "focus" },
      { toggleId: "programFocusPanelToggle", panel: "program-focus" },
      { toggleId: "fundingFocusPanelToggle", panel: "funding-focus" }
    ].forEach(({ toggleId, panel }) => {
      const toggle = document.getElementById(toggleId);
      if (!toggle) return;
      
      const handleToggle = (e) => {
        if (e.target.closest("input, select, textarea, a, button")) return;
        togglePanel(panel);
      };

      const heading = toggle.closest(".panel-heading") || toggle.closest(".tracker-topline");
      if (heading) {
        heading.style.cursor = "pointer";
        heading.addEventListener("click", handleToggle);
      }

      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        togglePanel(panel);
      });
    });

    document.body.addEventListener("click", (event) => {
      const tagPill = event.target.closest(".tag-pill:not(.facet-pill)");
      if (tagPill && !event.target.closest(".tag-remove")) {
        const tagId = tagPill.dataset.tagId;
        if (tagId) {
          event.preventDefault();
          navigateToTag(tagId);
          return;
        }
      }

      const targetToggle = event.target.closest("[data-linked-target-toggle]");
      if (targetToggle) {
        event.preventDefault();
        toggleLinkedTargetSection(targetToggle.dataset.linkedTargetToggle);
        return;
      }

      const managerButton = event.target.closest("[data-manager-open]");
      if (managerButton) {
        event.preventDefault();
        if (managerButton.dataset.managerOpen === "program") {
          openProgramModal(managerButton.dataset.id);
        } else if (managerButton.dataset.managerOpen === "funding") {
          openFundingModal(managerButton.dataset.id);
        }
        return;
      }

      const managerMediaButton = event.target.closest("[data-media-open]");
      if (managerMediaButton) {
        event.preventDefault();
        openMediaForEditing(managerMediaButton.dataset.mediaOpen);
        return;
      }

      const targetButton = event.target.closest("[data-target-action='edit-details']");
      if (targetButton) {
        event.preventDefault();
        openTargetForEditing(targetButton.dataset.id);
        return;
      }

      const campaignButton = event.target.closest("[data-linked-campaign-action='open']");
      if (campaignButton) {
        event.preventDefault();
        navigateToCampaign(campaignButton.dataset.id);
        return;
      }

      const feedbackButton = event.target.closest("[data-linked-feedback-action='open']");
      if (feedbackButton) {
        event.preventDefault();
        navigateToFeedback(feedbackButton.dataset.id);
        return;
      }

      const mediaButton = event.target.closest("[data-linked-media-action='edit']");
      if (!mediaButton) return;
      event.preventDefault();
      openMediaForEditing(mediaButton.dataset.id);
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (elements.settingsPanel?.open) return; // a native dialog; closes itself
        // Both of these open over a detail modal, so they take the key first;
        // otherwise Escape would close the record underneath them.
        if (elements.historyPreviewModal && !elements.historyPreviewModal.hidden) {
          closeHistoryPreviewDialog();
          return;
        }
        if (elements.historyRestoreModal && !elements.historyRestoreModal.hidden) {
          closeHistoryRestoreDialog();
          return;
        }
        if (elements.recordConflictModal && !elements.recordConflictModal.hidden) {
          closeRecordConflictModal();
          return;
        }
        if (elements.mediaDocumentModal && !elements.mediaDocumentModal.hidden) {
          requestCloseMediaDocumentModal();
          return;
        }
        const openModal = document.querySelector(".modal-overlay.open:not(#recordWindow):not(#mediaDocumentModal)");
        if (openModal && !openModal.hidden) {
          openModal.classList.remove("open");
          openModal.hidden = true;
          return;
        }
      }
    });

    elements.closeMediaDocumentModal.addEventListener("click", requestCloseMediaDocumentModal);
    elements.cancelMediaDocumentModal.addEventListener("click", requestCloseMediaDocumentModal);
    elements.saveMediaDocumentModal.addEventListener("click", saveMediaDocumentChanges);
    elements.mediaDocumentModal.addEventListener("click", (e) => {
      if (e.target === elements.mediaDocumentModal) {
        requestCloseMediaDocumentModal();
        return;
      }
      const retryBtn = e.target.closest("[data-media-retry-id]");
      if (retryBtn) {
        const media = findMediaItem(retryBtn.dataset.mediaRetryId);
        if (media) openMediaDocumentModal(media);
      }
    });

    // Click on focus queue item to show notes
    elements.focusList.addEventListener("click", (event) => {
      if (event.target.closest(".focus-link-open")) return;
      const focusItem = event.target.closest(".focus-item");
      if (!focusItem || !focusItem.dataset.id) return;
      const item = findItem(focusItem.dataset.id);
      if (item) openNotesModal(item);
    });

    // Keyboard support for focus items (Enter/Space)
    elements.focusList.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        if (event.target.closest(".focus-link-open")) return;
        const focusItem = event.target.closest(".focus-item");
        if (!focusItem || !focusItem.dataset.id) return;
        event.preventDefault();
        const item = findItem(focusItem.dataset.id);
        if (item) openNotesModal(item);
      }
    });

    document.querySelectorAll("#mediaDocumentModal .notes-editor-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        activateMediaDocumentTab(tab.dataset.mediaDocumentTab);
      });
    });

    elements.mediaDocumentInput.addEventListener("input", () => {
      updateMediaDocumentSaveState();
      const previewPane = document.getElementById("mediaDocumentPanePreview");
      if (previewPane && previewPane.classList.contains("active")) {
        updateMediaDocumentPreview();
      }
    });



    // Modal & Form open link buttons
    function bindOpenLinkBtn(btnEl, inputEl) {
      if (btnEl && inputEl) {
        btnEl.addEventListener("click", () => {
          const url = inputEl.value.trim();
          if (url) {
            const targetUrl = /^(?:f|ht)tps?:\/\//i.test(url) ? url : `https://${url}`;
            window.open(targetUrl, "_blank");
          }
        });
      }
    }

    bindOpenLinkBtn(elements.feedbackOpenLinkBtn, elements.feedbackLinkInput);


    // Global delegation for open-link buttons in preview banners
    document.addEventListener("click", (e) => {
      const openBtn = e.target.closest(".open-link-new-tab-btn");
      if (openBtn) {
        const url = openBtn.getAttribute("data-url");
        if (url) {
          const targetUrl = /^(?:f|ht)tps?:\/\//i.test(url) ? url : `https://${url}`;
          window.open(targetUrl, "_blank");
        }
      }
    });

    // Handle internal links (#item-XXX, #program-XXX, #funding-XXX) in notes preview panes
    const bindNotesPreviewInteractions = (previewId) => {
      const el = document.getElementById(previewId);
      if (!el) return;
      el.addEventListener("click", (e) => {
        const link = e.target.closest("a");
        if (link) {
          const href = link.getAttribute("href");
          if (href && href.startsWith("#item-")) {
            e.preventDefault();
            const itemId = href.slice(6);
            const item = findItem(itemId);
            if (item) openNotesModal(item, "preview");
            return;
          }
          if (href && href.startsWith("#program-")) {
            e.preventDefault();
            const progId = href.slice(9);
            openProgramModal(progId);
            return;
          }
          if (href && href.startsWith("#funding-")) {
            e.preventDefault();
            const fundId = href.slice(9);
            openFundingModal(fundId);
            return;
          }
          return; // Allow standard external link click
        }
      });
    };

    bindNotesPreviewInteractions("recordWindow");

    // Theme toggle & select controls
    elements.themeToggleButton.addEventListener("click", toggleTheme);
    window.addEventListener("beforeunload", flushAutosave);
    window.addEventListener("focus", handleWindowFocus);







    elements.mediaSearchInput.addEventListener("input", () => {
      state.mediaSearch = elements.mediaSearchInput.value.trim();
      state.mediaPage = 1;
      renderMediaAfterSearchInput();
    });

    elements.mediaTypeFilter.addEventListener("change", () => {
      state.mediaTypeFilter = elements.mediaTypeFilter.value;
      state.mediaPage = 1;
      renderMediaList();
    });

    elements.mediaSourceFilter.addEventListener("change", () => {
      state.mediaSourceFilter = elements.mediaSourceFilter.value;
      state.mediaPage = 1;
      renderMediaList();
    });

    elements.mediaTargetFilterMode?.addEventListener("change", () => {
      const mode = elements.mediaTargetFilterMode.value;
      state.mediaTargetFilter = mode === "record" ? "record" : mode;
      if (elements.mediaTargetFilter) elements.mediaTargetFilter.hidden = mode !== "record";
      if (mode === "record") mediaTargetFilterPicker().focus();
      state.mediaPage = 1;
      renderMediaList();
    });
    elements.mediaKindFilter?.addEventListener("change", () => {
      state.mediaKindFilter = elements.mediaKindFilter.value;
      state.mediaPage = 1;
      renderMediaList();
    });
    elements.mediaTagFilter?.addEventListener("change", () => {
      state.mediaTagFilter = elements.mediaTagFilter.value;
      state.mediaPage = 1;
      renderMediaList();
    });
    elements.mediaTargetFilter.addEventListener("change", () => {
      const picked = mediaTargetFilterPicker().getValue()[0];
      state.mediaTargetFilter = picked ? `${picked.kind}:${picked.id}` : "record";
      state.mediaPage = 1;
      renderMediaList();
    });

    bindTaxonomyTabs("mk");

    // A link pill or a linked record's name opens that record. Capture comes
    // first, so the row or card it sits in does not open its own record too.
    document.addEventListener("click", (event) => {
      const opener = event.target.closest?.("[data-link-open]");
      if (!opener) return;
      event.preventDefault();
      event.stopPropagation();
      openLinkedRecord(ItemPicker.parseKey(opener.dataset.linkOpen));
    }, true);


    // Tooltips show on hover and on keyboard focus; Escape hides them.
    document.body.addEventListener("mouseover", handleTooltipMouseOver);
    document.body.addEventListener("mouseout", handleTooltipMouseOut);
    document.body.addEventListener("focusin", handleTooltipMouseOver);
    document.body.addEventListener("focusout", handleTooltipMouseOut);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && document.getElementById("customTooltip")?.classList.contains("visible")) hideTooltip();
    });


    document.body.addEventListener("click", (event) => {
      const button = event.target.closest("[data-manager-page]");
      if (!button) return;
      const pageKey = button.dataset.managerPageKey;
      if (!["campaignPage", "tagPage", "mediaPage", "feedbackPage"].includes(pageKey)) return;
      state[pageKey] = Number(button.dataset.managerPage) || 1;
      render();
    });

    elements.taskRows.addEventListener("input", handleInlineInput);
    elements.taskRows.addEventListener("focusout", handleInlineBlur);

    // --- Tags + Extra Parameters bindings ---





    if (elements.campaignSearchInput) {
      elements.campaignSearchInput.addEventListener("input", () => {
        state.campaignSearch = elements.campaignSearchInput.value.trim();
        state.campaignPage = 1;
        renderCampaignsAfterSearchInput();
      });
    }

    if (elements.campaignStatusFilters) {
      elements.campaignStatusFilters.addEventListener("click", (event) => {
        const pill = event.target.closest(".filter-pill");
        if (!pill) return;
        const status = pill.dataset.status;
        const index = state.campaignStatusFilter.indexOf(status);
        if (index > -1) {
          state.campaignStatusFilter.splice(index, 1);
        } else {
          state.campaignStatusFilter.push(status);
        }
        state.campaignPage = 1;
        renderCampaignStatusFilters();
        renderCampaigns();
      });
    }

    if (elements.campaignFacetTagsInput) {
      elements.campaignFacetTagsInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === ",") {
          e.preventDefault();
          addCampaignTagFilter(elements.campaignFacetTagsInput.value);
          elements.campaignFacetTagsInput.value = "";
        }
      });
      elements.campaignFacetTagsInput.addEventListener("blur", () => {
        if (elements.campaignFacetTagsInput.value.trim()) {
          addCampaignTagFilter(elements.campaignFacetTagsInput.value);
          elements.campaignFacetTagsInput.value = "";
        }
      });
    }
    if (elements.campaignFacetTagsList) {
      elements.campaignFacetTagsList.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-campaign-facet-tag-remove]");
        if (btn) removeCampaignTagFilter(btn.dataset.campaignFacetTagRemove);
      });
    }

    if (elements.campaignList) {
      elements.campaignList.addEventListener("click", (e) => {
        const other = e.target.closest("[data-campaign-other-open]");
        if (other) {
          openRecordInOtherStartup(other.dataset.campaignOtherOpen, other.dataset.type, other.dataset.id);
          return;
        }
        const statusPill = e.target.closest("[data-campaign-target-status]");
        if (statusPill) {
          const status = statusPill.dataset.campaignTargetStatus;
          const index = state.campaignTargetStatusFilter.indexOf(status);
          if (index > -1) {
            state.campaignTargetStatusFilter.splice(index, 1);
          } else {
            state.campaignTargetStatusFilter.push(status);
          }
          renderCampaigns();
          return;
        }

        const priorityPill = e.target.closest("[data-campaign-target-priority]");
        if (priorityPill) {
          const priority = priorityPill.dataset.campaignTargetPriority;
          const index = state.campaignTargetPriorityFilter.indexOf(priority);
          if (index > -1) {
            state.campaignTargetPriorityFilter.splice(index, 1);
          } else {
            state.campaignTargetPriorityFilter.push(priority);
          }
          renderCampaigns();
          return;
        }

        const clearBtn = e.target.closest("[data-campaign-target-clear]");
        if (clearBtn) {
          state.campaignTargetStatusFilter = [];
          state.campaignTargetPriorityFilter = [];
          renderCampaigns();
          return;
        }
      });
    }

    if (elements.feedbackFacetTagsInput) {
      elements.feedbackFacetTagsInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === ",") {
          e.preventDefault();
          addFeedbackTagFilter(elements.feedbackFacetTagsInput.value);
          elements.feedbackFacetTagsInput.value = "";
        }
      });
      elements.feedbackFacetTagsInput.addEventListener("blur", () => {
        if (elements.feedbackFacetTagsInput.value.trim()) {
          addFeedbackTagFilter(elements.feedbackFacetTagsInput.value);
          elements.feedbackFacetTagsInput.value = "";
        }
      });
    }
    if (elements.feedbackFacetTagsList) {
      elements.feedbackFacetTagsList.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-feedback-facet-tag-remove]");
        if (btn) removeFeedbackTagFilter(btn.dataset.feedbackFacetTagRemove);
      });
    }

    [elements.feedbackTypeFilter, elements.feedbackStageFilter, elements.feedbackEvidenceFilter].forEach((select) => {
      if (!select) return;
      select.addEventListener("change", () => {
        if (select === elements.feedbackTypeFilter) state.feedbackTypeFilter = select.value || "all";
        if (select === elements.feedbackStageFilter) state.feedbackStageFilter = select.value || "all";
        if (select === elements.feedbackEvidenceFilter) state.feedbackEvidenceFilter = select.value || "all";
        state.feedbackPage = 1;
        renderFeedbackList();
      });
    });

    if (elements.tagSearchInput) {
      elements.tagSearchInput.addEventListener("input", () => {
        state.tagSearch = elements.tagSearchInput.value.trim();
        state.tagPage = 1;
        renderTagsAfterSearchInput();
      });
    }

    if (elements.tagUsageFilter) {
      elements.tagUsageFilter.addEventListener("change", () => {
        state.tagUsageFilter = elements.tagUsageFilter.value || "all";
        state.tagPage = 1;
        renderTags();
      });
    }

    if (elements.tagList) {
      elements.tagList.addEventListener("input", (event) => {
        const field = event.target.closest("[data-tag-field]");
        if (field) handleTagFieldInput(field);
      });
      elements.tagList.addEventListener("change", (event) => {
        const field = event.target.closest("[data-tag-field]");
        if (field) handleTagFieldInput(field, true);
      });
      elements.tagList.addEventListener("click", (event) => {
        const button = event.target.closest("[data-tag-action]");
        if (!button) return;
        const tagId = button.dataset.id;
        if (!tagId) return;
        if (button.dataset.tagAction === "edit") {
          state.editingTagId = tagId;
          renderTags();
        } else if (button.dataset.tagAction === "done") {
          state.editingTagId = null;
          renderTags();
        } else if (button.dataset.tagAction === "delete") {
          deleteTagDefinition(tagId);
        } else if (button.dataset.tagAction === "rename") {
          const input = elements.tagList.querySelector(`[data-tag-rename-input="${cssEscape(tagId)}"]`);
          const to = normalizeTagId(input?.value);
          if (!to || to === tagId) return;
          const merging = getAllTagRecords().some((other) => other.id === to);
          if (merging && !window.confirm(t("extra.tags.confirmRenameExisting", { from: tagId, to }))) return;
          runTagAction("rename", { from: tagId, to }, t("extra.tags.renamed", { from: tagId, to }));
        } else if (button.dataset.tagAction === "merge") {
          const select = elements.tagList.querySelector(`[data-tag-merge-target="${cssEscape(tagId)}"]`);
          const to = select?.value;
          if (!to) return;
          if (!window.confirm(t("extra.tags.confirmMerge", { from: tagId, to }))) return;
          runTagAction("merge", { from: [tagId], to }, t("extra.tags.merged", { from: tagId, to }));
        } else if (button.dataset.tagAction === "filter") {
          // Marketing targets with this tag.
          if (sectionPages.mk) Object.assign(sectionPages.mk.ui, { tags: [tagId], page: 1 });
          state.selectedAppTab = "pipeline";
          render();
        }
      });
    }

    elements.campaignList.addEventListener("input", (event) => {
      const field = event.target.closest("[data-campaign-field]");
      if (field) handleCampaignFieldInput(field);
    });
    elements.campaignList.addEventListener("change", (event) => {
      const field = event.target.closest("[data-campaign-field]");
      if (field) handleCampaignFieldInput(field, true);
    });
    elements.campaignList.addEventListener("keydown", (event) => {
      const input = event.target.closest("[data-campaign-tag-input]");
      if (!input) return;
      if (event.key === "Enter" || event.key === ",") {
        event.preventDefault();
        const value = input.value;
        input.value = "";
        addCampaignTag(input.dataset.id, value);
        focusCampaignTagInput(input.dataset.id);
      } else if (event.key === "Backspace" && !input.value) {
        const campaign = findCampaign(input.dataset.id);
        if (campaign && (campaign.tags || []).length) {
          event.preventDefault();
          removeCampaignTag(input.dataset.id, campaign.tags[campaign.tags.length - 1]);
          focusCampaignTagInput(input.dataset.id);
        }
      }
    });
    elements.campaignList.addEventListener("focusout", (event) => {
      const input = event.target.closest("[data-campaign-tag-input]");
      if (!input) return;
      if (input.value.trim()) {
        const value = input.value;
        input.value = "";
        addCampaignTag(input.dataset.id, value);
      }
    });
    elements.campaignList.addEventListener("click", (event) => {
      const removeBtn = event.target.closest("[data-campaign-tag-remove]");
      if (removeBtn) {
        removeCampaignTag(removeBtn.dataset.id, removeBtn.dataset.campaignTagRemove);
        return;
      }
      const button = event.target.closest("[data-campaign-action]");
      if (!button) return;
      const campaign = findCampaign(button.dataset.id);
      if (!campaign) return;
      if (button.dataset.campaignAction === "delete") {
        deleteCampaign(campaign);
      } else if (button.dataset.campaignAction === "edit") {
        state.editingCampaignId = campaign.id;
        renderCampaigns();
      } else if (button.dataset.campaignAction === "done") {
        state.editingCampaignId = null;
        renderCampaigns();
      }
    });

    elements.dailyGroups.addEventListener("input", (event) => {
      const field = event.target.closest("[data-daily-field]");
      if (field) handleDailyFieldInput(field);
    });
    elements.dailyGroups.addEventListener("change", (event) => {
      const field = event.target.closest("[data-daily-field]");
      if (field) handleDailyFieldInput(field, true);
    });
    elements.dailyGroups.addEventListener("click", (event) => {
      const groupButton = event.target.closest("[data-daily-open-group]");
      if (groupButton) {
        openDailyGroup(groupButton.dataset.dailyOpenGroup);
        return;
      }

      const actionButton = event.target.closest("[data-daily-action]");
      if (!actionButton) return;
      const link = findDailyLink(actionButton.dataset.id);
      if (!link) return;
      if (actionButton.dataset.dailyAction === "open") {
        openDailyLink(link);
      }
      if (actionButton.dataset.dailyAction === "delete") {
        deleteDailyLink(link);
      }
      if (actionButton.dataset.dailyAction === "edit") {
        state.editingDailyLinkId = link.id;
        renderDailyGroups();
      }
      if (actionButton.dataset.dailyAction === "done") {
        state.editingDailyLinkId = null;
        renderDailyGroups();
      }
    });

    if (elements.aiGroups) {
      elements.aiGroups.addEventListener("input", (event) => {
        const field = event.target.closest("[data-ai-field]");
        if (field) handleAiFieldInput(field);
      });
      elements.aiGroups.addEventListener("change", (event) => {
        const field = event.target.closest("[data-ai-field]");
        if (field) handleAiFieldInput(field, true);
      });
      elements.aiGroups.addEventListener("click", (event) => {
        const actionButton = event.target.closest("[data-ai-action]");
        if (!actionButton) return;
        const account = findAiAccount(actionButton.dataset.id);
        if (!account) return;
        if (actionButton.dataset.aiAction === "delete") {
          deleteAiAccount(account);
        } else if (actionButton.dataset.aiAction === "edit") {
          state.editingAiAccountId = account.id;
          renderAiGroups();
        } else if (actionButton.dataset.aiAction === "done") {
          state.editingAiAccountId = null;
          renderAiGroups();
        }
      });
    }

    if (elements.aiFlowWrap) {
      elements.aiFlowWrap.addEventListener("input", (event) => {
        const field = event.target.closest("[data-ai-flow-field]");
        if (field) handleAiFlowFieldInput(field);
      });
      elements.aiFlowWrap.addEventListener("change", (event) => {
        const field = event.target.closest("[data-ai-flow-field]");
        if (field) handleAiFlowFieldInput(field, true);
      });
      elements.aiFlowWrap.addEventListener("keydown", (event) => {
        const field = event.target.closest("[data-ai-flow-field]");
        if (field && event.key === "Enter") {
          event.preventDefault();
          const id = field.dataset.id;
          state.editingAiFlowIds.delete(id);
          persist(t("app.bindEvents.currentFlowEntrySaved"));
          renderAiFlow();
        }
      });
      let draggedFlowId = null;

      elements.aiFlowWrap.addEventListener("dragstart", (event) => {
        if (event.target.closest("input, textarea, select, button")) {
          event.preventDefault();
          return;
        }
        const row = event.target.closest("[data-ai-flow-id]");
        if (!row) return;
        draggedFlowId = row.dataset.aiFlowId;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", draggedFlowId);
        row.classList.add("is-dragging");
      });

      elements.aiFlowWrap.addEventListener("dragend", () => {
        draggedFlowId = null;
        elements.aiFlowWrap.querySelectorAll(".is-dragging, .drag-over-above, .drag-over-below").forEach((el) => {
          el.classList.remove("is-dragging", "drag-over-above", "drag-over-below");
        });
      });

      elements.aiFlowWrap.addEventListener("dragover", (event) => {
        const row = event.target.closest("[data-ai-flow-id]");
        if (!row || !draggedFlowId || row.dataset.aiFlowId === draggedFlowId) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";

        const rect = row.getBoundingClientRect();
        const isAbove = (event.clientY - rect.top) < (rect.height / 2);

        elements.aiFlowWrap.querySelectorAll(".drag-over-above, .drag-over-below").forEach((el) => {
          if (el !== row) el.classList.remove("drag-over-above", "drag-over-below");
        });

        if (isAbove) {
          row.classList.add("drag-over-above");
          row.classList.remove("drag-over-below");
        } else {
          row.classList.add("drag-over-below");
          row.classList.remove("drag-over-above");
        }
      });

      elements.aiFlowWrap.addEventListener("dragleave", (event) => {
        const row = event.target.closest("[data-ai-flow-id]");
        if (!row) return;
        if (!row.contains(event.relatedTarget)) {
          row.classList.remove("drag-over-above", "drag-over-below");
        }
      });

      elements.aiFlowWrap.addEventListener("drop", (event) => {
        const targetRow = event.target.closest("[data-ai-flow-id]");
        if (!targetRow || !draggedFlowId) return;
        event.preventDefault();

        const sourceId = draggedFlowId;
        const targetId = targetRow.dataset.aiFlowId;
        draggedFlowId = null;

        elements.aiFlowWrap.querySelectorAll(".is-dragging, .drag-over-above, .drag-over-below").forEach((el) => {
          el.classList.remove("is-dragging", "drag-over-above", "drag-over-below");
        });

        if (sourceId === targetId) return;
        const rect = targetRow.getBoundingClientRect();
        const insertBefore = (event.clientY - rect.top) < (rect.height / 2);
        reorderAiFlowItem(sourceId, targetId, insertBefore);
      });

      elements.aiFlowWrap.addEventListener("click", (event) => {
        const actionButton = event.target.closest("[data-ai-flow-action]");
        if (!actionButton || actionButton.disabled) return;
        const action = actionButton.dataset.aiFlowAction;
        if (action === "add") {
          addAiFlowItem();
          return;
        }
        if (action === "toggle-edit-all") {
          toggleEditAllAiFlow();
          return;
        }
        const id = actionButton.dataset.id;
        const item = findAiFlowItem(id);
        if (!item) return;
        if (action === "move-up") {
          moveAiFlowItem(id, "up");
        } else if (action === "move-down") {
          moveAiFlowItem(id, "down");
        } else if (action === "delete") {
          deleteAiFlowItem(item);
        } else if (action === "edit") {
          state.editingAiFlowIds.add(item.id);
          renderAiFlow();
          setTimeout(() => {
            const input = elements.aiFlowWrap?.querySelector(`input[data-id="${item.id}"][data-ai-flow-field="subApi"]`);
            if (input) input.focus();
          }, 0);
        } else if (action === "done") {
          state.editingAiFlowIds.delete(item.id);
          persist(t("app.bindEvents.currentFlowEntrySaved"));
          renderAiFlow();
        }
      });
    }

    elements.feedbackList.addEventListener("input", (event) => {
      const field = event.target.closest("[data-feedback-field]");
      if (field) {
        handleFeedbackFieldInput(field);
        // Re-render so type-conditional strategy fields appear/disappear when the
        // Type select changes on the editing card.
        if (field.dataset.feedbackField === "type") renderFeedbackList();
      }
    });
    elements.feedbackList.addEventListener("change", (event) => {
      const field = event.target.closest("[data-feedback-field]");
      if (field) handleFeedbackFieldInput(field, true);
    });
    elements.feedbackList.addEventListener("keydown", (event) => {
      const input = event.target.closest("[data-feedback-tag-input]");
      if (!input) return;
      if (event.key === "Enter" || event.key === ",") {
        event.preventDefault();
        const value = input.value;
        input.value = "";
        addFeedbackTag(input.dataset.id, value);
        focusFeedbackTagInput(input.dataset.id);
      } else if (event.key === "Backspace" && !input.value) {
        const item = findFeedbackItem(input.dataset.id);
        if (item && (item.tags || []).length) {
          event.preventDefault();
          removeFeedbackTag(input.dataset.id, item.tags[item.tags.length - 1]);
          focusFeedbackTagInput(input.dataset.id);
        }
      }
    });
    elements.feedbackList.addEventListener("focusout", (event) => {
      const input = event.target.closest("[data-feedback-tag-input]");
      if (!input) return;
      if (input.value.trim()) {
        const value = input.value;
        input.value = "";
        addFeedbackTag(input.dataset.id, value);
      }
    });
    elements.feedbackList.addEventListener("click", (event) => {
      const removeBtn = event.target.closest("[data-feedback-tag-remove]");
      if (removeBtn) {
        removeFeedbackTag(removeBtn.dataset.id, removeBtn.dataset.feedbackTagRemove);
        return;
      }
      const button = event.target.closest("[data-feedback-action]");
      if (!button) return;
      const item = findFeedbackItem(button.dataset.id);
      if (!item) return;
      if (button.dataset.feedbackAction === "delete") {
        deleteFeedbackItem(item);
      } else if (button.dataset.feedbackAction === "edit") {
        state.editingFeedbackItemId = item.id;
        renderFeedbackList();
      } else if (button.dataset.feedbackAction === "done") {
        state.editingFeedbackItemId = null;
        renderFeedbackList();
      }
    });

    elements.mediaList.addEventListener("input", (event) => {
      const field = event.target.closest("[data-media-field], [data-media-usage-field]");
      if (!field) return;
      if (field.dataset.mediaField) {
        handleMediaFieldInput(field);
      } else {
        handleMediaUsageFieldInput(field);
      }
    });

    elements.mediaList.addEventListener("change", (event) => {
      const field = event.target.closest("[data-media-field]");
      if (!field) return;
      handleMediaFieldInput(field, true);
    });

    elements.mediaList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-media-action]");
      if (!button) return;
      const media = findMediaItem(button.dataset.id);
      if (!media) return;
      if (button.dataset.mediaAction === "delete") {
        deleteMediaItem(media);
      } else if (button.dataset.mediaAction === "edit") {
        state.editingMediaItemId = media.id;
        renderMediaList();
      } else if (button.dataset.mediaAction === "done") {
        state.editingMediaItemId = null;
        renderMediaList();
      } else if (button.dataset.mediaAction === "copy-path") {
        event.preventDefault();
        copyMediaPath(media, button);
      } else if (button.dataset.mediaAction === "preview-document") {
        openMediaDocumentModal(media);
      } else if (button.dataset.mediaAction === "toggle-pin") {
        toggleMediaPin(media);
      } else if (button.dataset.mediaAction === "copy") {
        openMediaCopy(media);
      } else if (button.dataset.mediaAction === "copy-cancel") {
        state.copyingMediaId = null;
        renderMediaList();
      } else if (button.dataset.mediaAction === "copy-confirm") {
        const select = elements.mediaList.querySelector(`[data-media-copy-to="${cssEscape(media.id)}"]`);
        copyMediaToStartup(media, select?.value || "");
      }
    });

    // Table sorting events
    const headers = document.querySelectorAll(".table-wrap thead th.sortable");
    headers.forEach((th) => {
      th.addEventListener("click", () => {
        const col = th.getAttribute("data-sort-col");
        if (state.sortColumn === col) {
          if (state.sortDirection === "asc") {
            state.sortDirection = "desc";
          } else {
            state.sortColumn = null;
            state.sortDirection = null;
          }
        } else {
          state.sortColumn = col;
          state.sortDirection = "asc";
        }
        render();
      });
    });

    bindTaxonomyTabs("po");

    bindTaxonomyTabs("fu");

    // --- Calendar Tab Initialization ---

    if (elements.fundingRoundForm) {
      elements.fundingRoundForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const name = String(elements.fundingRoundNameInput.value || "").trim();
        if (!name) return alert(t("app.bindEvents.roundNameIsRequired"));
        const round = normalizeFundingRound({
          name,
          stage: elements.fundingRoundStageInput.value,
          targetAmount: elements.fundingRoundTargetInput.value,
          currency: elements.fundingRoundCurrencyInput.value,
          minimumClose: elements.fundingRoundMinimumInput.value,
          expectedCloseDate: elements.fundingRoundCloseInput.value,
        });
        state.fundingRounds.unshift(round);
        elements.fundingRoundForm.reset();
        elements.fundingRoundCurrencyInput.value = "EUR";
        persist(t("app.bindEvents.fundingRoundAdded"));
        renderFundingRounds();
      });
    }
    if (elements.fundingRoundList) {
      elements.fundingRoundList.addEventListener("input", (event) => {
        const field = event.target.closest("[data-round-field]");
        if (!field) return;
        const round = state.fundingRounds.find((entry) => entry.id === field.dataset.id);
        if (!round) return;
        const key = field.dataset.roundField;
        round[key] = ["targetAmount", "minimumClose"].includes(key)
          ? Math.max(0, Number(field.value) || 0)
          : key === "currency"
            ? String(field.value || "EUR").trim().toUpperCase()
            : String(field.value || "").trim();
        round.updatedAt = new Date().toISOString();
        scheduleAutosave();
      });
      elements.fundingRoundList.addEventListener("change", () => renderFundingRounds());
      elements.fundingRoundList.addEventListener("click", (event) => {
        const button = event.target.closest("[data-round-action='delete']");
        if (!button) return;
        const round = state.fundingRounds.find((entry) => entry.id === button.dataset.id);
        if (!round || !window.confirm(t("app.bindEvents.deleteFundingRoundLinkedDeals", { name: round.name }))) return;
        state.fundingRounds = state.fundingRounds.filter((entry) => entry.id !== round.id);
        if (state.selectedFundingRound === round.id) state.selectedFundingRound = "all";
        state.funding.forEach((funding) => {
          if (funding.roundId === round.id) funding.roundId = "";
        });
        persist(t("app.bindEvents.fundingRoundDeleted"));
        render();
      });
    }

  }


  async function loadStateFromServer(options = {}) {
    const forceSnapshot = options.forceSnapshot === true;
    try {
      if (pendingOutbox.length > 0 && !forceSnapshot) {
        state.apiReady = true;
        markSyncing(t("app.loadStateFromServer.syncingSavedChanges"));
        await reconcileLegacyBlockedConflicts();
        if (pendingOutbox.length === 0) {
          // A legacy cache may have been the only reason this tab skipped the
          // server request. Once its local queue is gone, replace that cached
          // snapshot with the authoritative state, even if the old revision
          // happens to match and would otherwise produce a 304.
          await loadStateFromServer({ forceSnapshot: true });
          return;
        }
        // `persist()` drains every sendable batch. Calling the single-batch
        // sender here left a stale cached snapshot on screen after reload.
        const synced = await persist(SAVE_STATE.synced);
        if (synced && pendingOutbox.length === 0) {
          // A successful replay only acknowledges local operations; it does
          // not include edits made by another writer. Fetch a full snapshot so
          // this tab cannot keep serving the old IndexedDB state.
          await loadStateFromServer({ forceSnapshot: true });
        }
        return;
      }
      // Validate on the revision counter: the server changes it exactly when
      // the content changes, and matching it costs no hashing on either side.
      const requestHeaders = state.lastServerRevision && serverRevisionMap
        ? { "If-None-Match": `W/"rev-${state.lastServerRevision}"` }
        : {};
      const response = await fetch(API_STATE_URL, { cache: "no-store", headers: requestHeaders });
      state.apiReady = true;

      if (response.status === 304) {
        // The ETag is the revision now, not a content hash, so it must not be
        // written into lastServerFileHash. 304 means the content is unchanged,
        // which leaves the hash already held here correct.
        state.lastServerRevision = Number(response.headers.get("X-State-Revision")) || state.lastServerRevision;
        state.filePath = response.headers.get("X-File-Path") || state.filePath;
        state.mediaDir = response.headers.get("X-Media-Dir") || state.mediaDir;
        await cacheCurrentState(pendingOutbox, { stateUnchanged: true });
        if (state.recordConflicts?.length) showRecordConflictNotification(state.recordConflicts);
        else if (pendingOutbox.length) markSaved(SAVE_STATE.local);
        else markSaved(SAVE_STATE.synced);
        return;
      }

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const previousServerFileHash = state.lastServerFileHash;
      state.filePath = payload.filePath || "";
      state.mediaDir = payload.mediaDir || "";
      state.lastServerFileHash = payload.fileHash || "";
      state.lastServerRevision = Number(payload.revision) || 0;
      acceptServerRevisionMap(payload.revisionMap);
      const trackerState = payload.state || null;

      if (trackerState) {
        const serverSignature = getPersistedContentSignature(trackerState);
        const serverFileChanged = !previousServerFileHash
          || !state.lastServerFileHash
          || previousServerFileHash !== state.lastServerFileHash;

        // A conditional request should normally return 304 here. Keep this
        // guard as well for older browsers/proxies that return the full body
        // even when the file hash is unchanged.
        if (!forceSnapshot && !serverFileChanged) {
          await saveStateToLocalCache(trackerState, null, state.lastServerFileHash);
          acceptAcknowledgedPersistedState(buildPersistedState());
          markSaved(SAVE_STATE.synced);
          return;
        }

        // The file hash can change for metadata-only edits such as updatedAt.
        // Compare the persisted content before replacing the already-rendered
        // state so a refresh does not look like a data sync when nothing
        // meaningful changed.
        const currentClientSignature = getPersistedContentSignature(buildPersistedState());
        const isContentIdentical = serverSignature === currentClientSignature
          || serverSignature === getLastPersistedContentSignature();
        if (isContentIdentical) {
          await saveStateToLocalCache(trackerState, null, state.lastServerFileHash);
          acceptAcknowledgedPersistedState(buildPersistedState());
          markSaved(SAVE_STATE.synced);
          return;
        }

        state.isSyncing = true;
        markSyncing(t("app.loadStateFromServer.syncingData"));
        applyLoadedState(trackerState);
        await saveStateToLocalCache(trackerState, null, state.lastServerFileHash);
        acceptAcknowledgedPersistedState(buildPersistedState());
        markSaved(SAVE_STATE.synced);
      } else {
        state.items = [];
        state.deletedItems = [];
        await persist(t("app.loadStateFromServer.created"));
      }
    } catch (error) {
      state.apiReady = localCacheAvailable ? false : state.apiReady;
      const cachedState = await loadStateFromLocalCache();
      if (!cachedState) {
        state.items = [];
        state.deletedItems = [];
      }
      markDataChanged();
      if (!localCacheAvailable) markSaved(t("app.loadStateFromServer.browserStorageUnavailable"));
      else markSaved(pendingOutbox.length ? t("app.loadStateFromServer.savedLocallyWaitingToSync") : t("app.loadStateFromServer.backendOffline"));
    }
  }

  function applyLoadedState(trackerState) {
    markDataChanged();
    // Categories come from the shared library (js/taxonomy-model.js). A
    // startup's own older category list is kept as it was, unused.
    state.legacyCategories = Array.isArray(trackerState.categories) ? trackerState.categories : null;
    state.enabledTaxonomy = trackerState.enabledTaxonomy && typeof trackerState.enabledTaxonomy === "object" && !Array.isArray(trackerState.enabledTaxonomy)
      ? trackerState.enabledTaxonomy
      : null;
    refreshTaxonomy();

    if (Array.isArray(trackerState.extraParamsDefinition) && trackerState.extraParamsDefinition.length) {
      extraParamsDefinition = mergeExtraParamsDefinitions(trackerState.extraParamsDefinition);
    } else {
      extraParamsDefinition = JSON.parse(JSON.stringify(DEFAULT_EXTRA_PARAMS));
    }

    // Shared research links stay as the shared data last gave them.
    const sharedDeletedLinks = state.deletedDailyLinks.filter((link) => link.shared);
    BIN_SECTIONS_ADDED_IN_PART_3.forEach((section) => {
      state[section] = loadBinSection(trackerState[section]);
    });
    state.deletedDailyLinks = [...state.deletedDailyLinks.filter((link) => !link.shared), ...sharedDeletedLinks];
    state.profile = trackerState.profile && typeof trackerState.profile === "object" && !Array.isArray(trackerState.profile)
      ? trackerState.profile
      : null;

    const loadedItems = Array.isArray(trackerState.items) ? trackerState.items : [];
    const loadedDeleted = Array.isArray(trackerState.deletedItems) ? trackerState.deletedItems : [];
    state.dailyLinks = [
      ...(Array.isArray(trackerState.dailyLinks) ? trackerState.dailyLinks.map(normalizeDailyLink).filter(Boolean).filter((link) => !link.shared) : []),
      ...state.dailyLinks.filter((link) => link.shared),
    ];
    state.feedbackItems = Array.isArray(trackerState.feedbackItems)
      ? trackerState.feedbackItems.map(normalizeFeedbackItem).filter(Boolean)
      : [];
    state.programs = Array.isArray(trackerState.programs)
      ? trackerState.programs.map(normalizeProgram).filter(Boolean)
      : [];
    state.funding = Array.isArray(trackerState.funding)
      ? trackerState.funding.map(normalizeFundingSource).filter(Boolean)
      : [];
    state.fundingRounds = Array.isArray(trackerState.fundingRounds)
      ? trackerState.fundingRounds.map(normalizeFundingRound).filter(Boolean)
      : [];
    state.deletedPrograms = Array.isArray(trackerState.deletedPrograms)
      ? trackerState.deletedPrograms.map(normalizeProgram).filter(Boolean)
      : [];
    state.deletedFunding = Array.isArray(trackerState.deletedFunding)
      ? trackerState.deletedFunding.map(normalizeFundingSource).filter(Boolean)
      : [];

    state.companyProfile = trackerState.companyProfile && typeof trackerState.companyProfile === "object" && !Array.isArray(trackerState.companyProfile)
      ? trackerState.companyProfile
      : null;
    for (const section of COMPANY_RECORD_SECTIONS) state[section] = loadBinSection(trackerState[section]);
    companyPageInstance?.forgetSecrets();
    loadCompanyTemplate();

    state.items = loadedItems.map(normalizeItem).filter(Boolean);
    state.deletedItems = loadedDeleted.map(normalizeItem).filter(Boolean);
    state.mediaItems = Array.isArray(trackerState.mediaItems)
      ? trackerState.mediaItems.map(normalizeMediaItem).filter(Boolean)
      : [];
    // Links between records. Fields that linked records before links existed
    // (linked ids, media "used in", a feedback's target, "Blocked by" and
    // "Blocks") become links once; the records drop those fields.
    const storedLinks = (Array.isArray(trackerState.links) ? trackerState.links : []).flatMap((link) => {
      try {
        return [Links.validateLink(link)];
      } catch {
        return [];
      }
    });
    const legacyLinks = Links.fromLegacy(trackerState);
    state.links = Links.mergeLinks(storedLinks, legacyLinks);
    // Saved on the next write: the new links, and the records without the old
    // fields (otherwise a link removed here would come back on the next load).
    const storedLinkIds = new Set(storedLinks.map((link) => link.id));
    const migrated = {
      links: legacyLinks.filter((link) => !storedLinkIds.has(link.id)).map((link) => link.id),
      records: Links.legacyRecords(trackerState),
    };
    // Older field keys with exactly one new home move into it (js/fields.js
    // MOVES), and those records are saved once too.
    for (const [section, collections] of [["mk", ["items", "deletedItems"]], ["po", ["programs", "deletedPrograms"]], ["fu", ["funding", "deletedFunding"]]]) {
      for (const collection of collections) {
        state[collection] = state[collection].map((record) => {
          const result = Fields.migrate(section, record);
          if (result.changed) migrated.records.push({ section: collection, id: String(record.id) });
          return result.record;
        });
      }
    }
    pendingLinkMigration = migrated.links.length || migrated.records.length ? migrated : null;

    state.focusStatuses = restoreStatusFilter(trackerState.focusStatuses);
    if (typeof trackerState.focusPageSize === "number") {
      state.focusPageSize = trackerState.focusPageSize;
    } else {
      state.focusPageSize = 6;
    }
    if (typeof trackerState.programFocusPageSize === "number") {
      state.programFocusPageSize = trackerState.programFocusPageSize;
    } else {
      state.programFocusPageSize = 6;
    }
    if (typeof trackerState.fundingFocusPageSize === "number") {
      state.fundingFocusPageSize = trackerState.fundingFocusPageSize;
    } else {
      state.fundingFocusPageSize = 6;
    }
    feedbackAboutPicker();
  }

  function mergeExtraParamsDefinitions(savedDefinitions) {
    const saved = Array.isArray(savedDefinitions) ? savedDefinitions : [];
    const normalized = saved
      .map((param) => {
        if (!param || typeof param !== "object") return null;
        return {
          id: String(param.id || "").trim(),
          name: String(param.name || "Untitled Parameter").trim() || "Untitled Parameter",
          group: String(param.group || "Custom").trim() || "Custom",
          type: ["text", "number", "date", "select", "multiselect"].includes(param.type) ? param.type : "text",
          description: String(param.description || ""),
          examples: String(param.examples || ""),
          defaults: Array.isArray(param.defaults) ? param.defaults.map((entry) => String(entry)) : [],
        };
      })
      .filter((param) => param && param.id && !RETIRED_TARGET_EXTRA_PARAM_IDS.has(param.id));

    const existingIds = new Set(normalized.map((param) => param.id));
    DEFAULT_EXTRA_PARAMS.forEach((param) => {
      if (!existingIds.has(param.id)) {
        normalized.push(JSON.parse(JSON.stringify(param)));
      }
    });

    return normalized;
  }

  // The record types whose bin sections Part 3 added (the MK, PO and FU bins
  // are older and load with their own normalizers).
  // (Campaign, tag and prompt bins are shared; applyGlobalSections loads them.)
  const BIN_SECTIONS_ADDED_IN_PART_3 = [
    "deletedMediaItems",
    "deletedFeedbackItems",
    "deletedDailyLinks",
  ];

  // Records of a bin section as stored: objects with an id, each id once.
  function loadBinSection(value) {
    const seen = new Set();
    return (Array.isArray(value) ? value : []).filter((record) => {
      const id = record && typeof record === "object" ? String(record.id ?? "") : "";
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  // ---- Shared data (js/global-data.js) ----------------------------------------
  //
  // Campaigns, tag definitions, the AI page and research links ticked
  // "Shared" belong to every startup. They load from /api/global and are
  // written straight back a moment after each change, outside the startup's
  // outbox; js/global-data.js reloads them when another tab changed the same
  // record first.

  const DEFAULT_USD_TO_RON = 4.55;
  let globalChannel = null;

  function normalizeTagDefinition(def) {
    if (!def || typeof def !== "object") return null;
    const id = normalizeTagId(def.id);
    if (!id) return null;
    const color = /^#[0-9a-f]{6}$/i.test(String(def.color || "")) ? String(def.color).toLowerCase() : "";
    return {
      id,
      label: String(def.label || id).trim() || id,
      description: String(def.description || ""),
      ...(color ? { color } : {}),
    };
  }

  function normalizeAiSettings(value) {
    const rate = Number(value?.usdToRon);
    return {
      usdToRon: Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_USD_TO_RON,
      rateUpdatedAt: typeof value?.rateUpdatedAt === "string" ? value.rateUpdatedAt : "",
    };
  }

  // The shared sections as the server (or the offline copy) holds them.
  // The default tags are added once, the first time shared data exists; after
  // that a deleted default stays deleted.
  function applyGlobalSections(sections, { seedDefaults = false } = {}) {
    const list = (value) => (Array.isArray(value) ? value : []);
    state.campaigns = list(sections.campaigns).map(normalizeCampaign).filter(Boolean);
    state.deletedCampaigns = loadBinSection(sections.deletedCampaigns);
    state.deletedTags = loadBinSection(sections.deletedTags);
    state.globalSeeded = sections.seeded && typeof sections.seeded === "object" && !Array.isArray(sections.seeded) ? { ...sections.seeded } : {};
    tagDefinitions = list(sections.tags).map(normalizeTagDefinition).filter(Boolean);
    if (seedDefaults && !state.globalSeeded.tags) {
      const known = new Set([...tagDefinitions, ...state.deletedTags].map((def) => normalizeTagId(def.id)));
      DEFAULT_TAG_DEFINITIONS.forEach((def) => {
        if (!known.has(def.id)) tagDefinitions.push(normalizeTagDefinition(def));
      });
      state.globalSeeded = { ...state.globalSeeded, tags: new Date().toISOString() };
    }
    state.aiAccounts = list(sections.aiAccounts).map(normalizeAiAccount).filter(Boolean);
    state.aiFlow = list(sections.aiFlow).map(normalizeAiFlowItem).filter(Boolean);
    state.aiSettings = normalizeAiSettings(sections.aiSettings);
    state.prompts = list(sections.prompts).filter((prompt) => prompt && prompt.id && typeof prompt.body === "string");
    state.deletedPrompts = loadBinSection(sections.deletedPrompts);
    state.promptPresets = list(sections.promptPresets).filter((preset) => preset && preset.id);
    state.promptExamples = list(sections.promptExamples).filter((example) => example && example.id);
    const shared = (records) => records.filter(Boolean).map((link) => ({ ...link, shared: true }));
    state.dailyLinks = [
      ...state.dailyLinks.filter((link) => !link.shared),
      ...shared(list(sections.dailyLinks).map(normalizeDailyLink)),
    ];
    state.deletedDailyLinks = [
      ...state.deletedDailyLinks.filter((link) => !link.shared),
      ...shared(loadBinSection(sections.deletedDailyLinks)),
    ];
    markDataChanged();
  }

  function collectGlobalSections() {
    return {
      campaigns: state.campaigns,
      deletedCampaigns: state.deletedCampaigns,
      tags: tagDefinitions,
      deletedTags: state.deletedTags,
      aiAccounts: state.aiAccounts,
      aiFlow: state.aiFlow,
      aiSettings: state.aiSettings,
      prompts: state.prompts,
      deletedPrompts: state.deletedPrompts,
      promptPresets: state.promptPresets,
      promptExamples: state.promptExamples,
      dailyLinks: state.dailyLinks.filter((link) => link.shared),
      deletedDailyLinks: state.deletedDailyLinks.filter((link) => link.shared),
      seeded: state.globalSeeded,
    };
  }

  function browserStorage() {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }

  async function loadGlobalData() {
    globalChannel = GlobalData.create({
      urls: Api.urls,
      storage: browserStorage(),
      cacheKey: Api.globalStorageKey("shared-data-cache"),
      hooks: {
        collect: collectGlobalSections,
        apply: (sections) => {
          applyGlobalSections(sections);
          render();
        },
        status: (kind) => {
          if (kind === "conflict") markSaved(t("shared.reloaded"));
          else if (kind === "error") markSaved(t("shared.saveFailed"));
        },
      },
    });
    const { sections, offline } = await globalChannel.load();
    applyGlobalSections(sections, { seedDefaults: !offline });
    if (!offline) globalChannel.schedule();
  }

  // Another tab or startup may have changed the shared data meanwhile.
  async function refreshGlobalData() {
    if (!globalChannel) return;
    try {
      const sections = await globalChannel.refresh();
      if (!sections) return;
      applyGlobalSections(sections);
      render();
    } catch {
      // The next focus tries again.
    }
  }

  // The shared option lists (js/options.js). The Programs documents
  // checklist is one of them and feeds the target window.
  async function loadOptionLists() {
    try {
      await Options.load(fetch, Api.urls.options);
    } catch {
      // Without the server the lists stay empty until the next load; records
      // keep their values and show them as stored.
    }
    applyOptionLists();
  }

  function applyOptionLists() {
    Fields.setDocumentChecklist(Options.isEdited("documentChecklist") ? Options.list("documentChecklist") : null);
  }

  function normalizeCampaignId(value) {
    const id = String(value || "").trim();
    if (!id) return "";
    return state.campaigns.some((campaign) => campaign.id === id) ? id : "";
  }

  function normalizeCampaign(campaign) {
    if (!campaign || typeof campaign !== "object") return null;
    // An unknown campaign status is kept, like a target's.
    const status = typeof campaign.status === "string" && campaign.status ? campaign.status : defaultCampaignStatus();
    const now = new Date().toISOString();

    return {
      id: String(campaign.id || makeId()).trim() || makeId(),
      name: String(campaign.name || "Untitled campaign").trim() || "Untitled campaign",
      description: String(campaign.description || "").trim(),
      goal: String(campaign.goal || "").trim(),
      hypothesis: String(campaign.hypothesis || "").trim(),
      successMetric: String(campaign.successMetric || "").trim(),
      status,
      startDate: /^\d{4}-\d{2}-\d{2}$/.test(campaign.startDate || "") ? campaign.startDate : "",
      endDate: /^\d{4}-\d{2}-\d{2}$/.test(campaign.endDate || "") ? campaign.endDate : "",
      tags: normalizeTagArray(campaign.tags),
      createdAt: campaign.createdAt || now,
      updatedAt: campaign.updatedAt || now,
    };
  }

  function parseDailyUrlList(value) {
    return String(value || "")
      .split(";")
      .map(cleanStoredLink)
      .filter(Boolean);
  }

  function normalizeDailyUrlList(value) {
    return parseDailyUrlList(value).join("; ");
  }

  function getDailyLinkUrls(value) {
    return Array.from(new Set(parseDailyUrlList(value).map(safeLink).filter(Boolean)));
  }

  // A research link. `subcategory` holds the id of its group (Research links
  // > Groups); a group name from before the groups became editable is read
  // as that group, and a group that was removed is kept as stored. `shared`
  // links belong to every startup and are saved with the shared data.
  function normalizeDailyLink(link) {
    if (!link || typeof link !== "object") return null;
    const now = new Date().toISOString();
    const priority = dailyPriorities.includes(link.priority) ? link.priority : "Medium";

    return {
      id: String(link.id || makeId()).trim() || makeId(),
      subcategory: researchGroupId(link.subcategory),
      title: String(link.title || "Untitled link").trim() || "Untitled link",
      url: normalizeDailyUrlList(link.url),
      description: String(link.description || "").trim(),
      active: link.active !== false,
      priority,
      shared: Boolean(link.shared),
      lastOpenedAt: link.lastOpenedAt || "",
      createdAt: link.createdAt || now,
      updatedAt: link.updatedAt || now,
    };
  }

  function researchGroupId(value) {
    const raw = String(value || "").trim();
    if (!raw) return "other";
    const groups = Options.list("researchGroups");
    if (groups.some((group) => group.id === raw)) return raw;
    const byLabel = groups.find((group) => group.label.toLowerCase() === raw.toLowerCase());
    return byLabel ? byLabel.id : raw;
  }

  function researchGroupIcon(groupId) {
    const group = Options.find("researchGroups", groupId);
    const icon = LinkTypes.typeById(group?.linkType || "other").icon;
    return `<svg class="research-group-icon" aria-hidden="true"><use href="#icon-${escapeAttribute(icon)}"></use></svg>`;
  }

  function normalizeAiLinks(value) {
    const source = Array.isArray(value)
      ? value
      : String(value || "")
        .split(/[;\r\n]+/)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
          const separator = entry.indexOf("|");
          if (separator < 0) return { label: t("app.normalizeAiLinks.open"), url: entry };
          return {
            label: entry.slice(0, separator).trim() || "Open",
            url: entry.slice(separator + 1).trim(),
          };
        });

    const seen = new Set();
    return source
      .map((link) => {
        if (!link || typeof link !== "object") return null;
        const url = safeLink(link.url || link.href || "");
        if (!url || seen.has(url)) return null;
        seen.add(url);
        return {
          label: String(link.label || "Open").trim() || "Open",
          url,
        };
      })
      .filter(Boolean);
  }

  function normalizeAiAccount(account) {
    if (!account || typeof account !== "object") return null;
    const name = String(account.name || "").trim();
    if (!name) return null;
    return {
      id: String(account.id || makeId()).trim() || makeId(),
      kind: account.kind === "subscription" ? "subscription" : "api",
      name,
      cost: String(account.cost || "").trim(),
      models: String(account.models || "").trim(),
      details: String(account.details || "").trim(),
      links: normalizeAiLinks(account.links),
      hasSeparatorAbove: Boolean(account.hasSeparatorAbove || account.separatorAbove || account.separator),
      strikethrough: Boolean(account.strikethrough || account.strikethroughLine || account.isStrikethrough),
    };
  }

  function normalizeAiFlowItem(item) {
    if (!item || typeof item !== "object") return null;
    const isSeparator = Boolean(item.isSeparator || item.type === "separator");
    if (isSeparator) {
      return {
        id: String(item.id || "ai-flow-separator-occasional").trim() || "ai-flow-separator-occasional",
        isSeparator: true,
        title: String(item.title || item.subApi || "occasional").trim() || "occasional",
      };
    }
    const subApi = String(item.subApi || item.name || "").trim();
    const model = String(item.model || item.models || "").trim();
    const details = String(item.details || "").trim();
    return {
      id: String(item.id || makeId()).trim() || makeId(),
      subApi,
      model,
      details,
    };
  }

  function normalizeFeedbackRepeatUsageCount(value) {
    const nextValue = String(value ?? "").trim();
    if (!nextValue) return "";
    const numberValue = Number(nextValue);
    if (!Number.isFinite(numberValue) || numberValue < 0) return "";
    return String(Math.floor(numberValue));
  }

  // A feedback record. Option values (type, source, stage...) are kept as
  // stored even when their option was removed from Feedback > Options, and
  // fields from older versions are kept as they were.
  function normalizeFeedbackItem(item) {
    if (!item || typeof item !== "object") return null;
    const now = new Date().toISOString();
    const option = (value, fallback) => String(value ?? "").trim() || fallback;
    const text = (value) => String(value || "").trim();
    const date = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : "");
    // targetId was the old "About" field; it is a link now (js/links-model.js).
    const { targetId, ...kept } = item;
    void targetId;

    return {
      ...kept,
      id: String(item.id || makeId()).trim() || makeId(),
      type: option(item.type, "feedback"),
      source: option(item.source, "other"),
      audience: text(item.audience),
      contactName: text(item.contactName),
      relationshipDepth: option(item.relationshipDepth, "none"),
      stage: option(item.stage, "unknown"),
      area: option(item.area, "other"),
      evidenceLevel: option(item.evidenceLevel, "anecdote"),
      title: text(item.title) || "Untitled feedback",
      description: text(item.description),
      link: cleanStoredLink(item.link),
      outcome: text(item.outcome),
      action: text(item.action),
      userRole: text(item.userRole),
      teamContext: text(item.teamContext),
      currentAlternative: text(item.currentAlternative),
      useCase: text(item.useCase),
      journeyStep: item.journeyStep === "not-tracked" ? "" : text(item.journeyStep),
      repeatUsageCount: normalizeFeedbackRepeatUsageCount(item.repeatUsageCount),
      dropOffReason: text(item.dropOffReason),
      status: feedbackStatuses.includes(item.status) ? item.status : "new",
      tags: normalizeTagArray(item.tags),
      hypothesis: text(item.hypothesis),
      evidenceFor: text(item.evidenceFor),
      evidenceAgainst: text(item.evidenceAgainst),
      verdict: option(item.verdict, "untested"),
      nextReviewDate: date(item.nextReviewDate),
      nextActionDate: date(item.nextActionDate),
      createdAt: item.createdAt || now,
      updatedAt: item.updatedAt || now,
    };
  }

  function normalizeMediaItem(item) {
    if (!item || typeof item !== "object") return null;
    const now = new Date().toISOString();
    const sourceType = mediaSources.includes(item.sourceType) ? item.sourceType : "upload";
    // A type removed from Media > Options is kept as stored.
    const type = String(item.type || "").trim() || guessMediaType(item);
    const originalName = String(item.originalName || "").trim();
    const externalPath = cleanStoredLink(item.externalPath || item.url);
    const filePath = String(item.filePath || item.path || "").trim();
    const absolutePath = String(item.absolutePath || "").trim();
    const fallbackTitle = originalName || externalPath || filePath || "Untitled media";
    const tags = normalizeTagArray(item.tags);

    return {
      id: String(item.id || makeId()).trim() || makeId(),
      title: String(item.title || fallbackTitle).trim() || "Untitled media",
      type,
      sourceType,
      filePath,
      absolutePath,
      externalPath,
      originalName,
      storedName: String(item.storedName || "").trim(),
      mimeType: String(item.mimeType || "").trim(),
      size: Number(item.size) || 0,
      tags,
      notes: String(item.notes || "").trim(),
      pinned: Boolean(item.pinned),
      createdAt: item.createdAt || now,
      updatedAt: item.updatedAt || now,
    };
  }

  function normalizeProgramActivity(entry) {
    if (!entry || typeof entry !== "object") return null;
    const now = new Date().toISOString();
    const type = PROGRAM_ACTIVITY_TYPES.some((activityType) => activityType.id === entry.type) ? entry.type : "other";
    const previousAction = String(entry.previousAction || "").trim();
    const previousActionStatus = PROGRAM_ACTIVITY_PREVIOUS_ACTION_STATUSES.some((status) => status.id === entry.previousActionStatus)
      ? entry.previousActionStatus
      : (previousAction ? "completed" : "none");
    const loggedAt = entry.loggedAt && !Number.isNaN(new Date(entry.loggedAt).getTime()) ? entry.loggedAt : now;

    return {
      ...entry,
      id: String(entry.id || makeId()).trim() || makeId(),
      date: /^\d{4}-\d{2}-\d{2}$/.test(entry.date || "") ? entry.date : "",
      time: /^\d{2}:\d{2}$/.test(entry.time || "") ? entry.time : "",
      type,
      outcome: String(entry.outcome || "").trim(),
      previousAction,
      previousActionDate: /^\d{4}-\d{2}-\d{2}$/.test(entry.previousActionDate || "") ? entry.previousActionDate : "",
      previousActionTime: /^\d{2}:\d{2}$/.test(entry.previousActionTime || "") ? entry.previousActionTime : "",
      previousActionOwner: String(entry.previousActionOwner || "").trim(),
      previousActionStatus,
      nextAction: String(entry.nextAction || "").trim(),
      nextActionDate: /^\d{4}-\d{2}-\d{2}$/.test(entry.nextActionDate || "") ? entry.nextActionDate : "",
      nextActionTime: /^\d{2}:\d{2}$/.test(entry.nextActionTime || "") ? entry.nextActionTime : "",
      owner: String(entry.owner || "").trim(),
      statusAfter: typeof entry.statusAfter === "string" ? entry.statusAfter : "",
      blocker: String(entry.blocker || "").trim(),
      round: String(entry.round || "").trim(),
      sourceUrl: cleanStoredLink(entry.sourceUrl),
      notes: String(entry.notes || "").trim(),
      loggedAt,
    };
  }

  function normalizeProgram(prog) {
    if (!prog || typeof prog !== "object") return null;
    const now = new Date().toISOString();
    const status = typeof prog.status === "string" && prog.status ? prog.status : Statuses.defaultStatus();
    const priority = ["Very High", "High", "Medium", "Low", "Very Low"].includes(prog.priority) ? prog.priority : "Medium";
    
    const timeEntries = Array.isArray(prog.timeEntries)
      ? prog.timeEntries.map((te) => ({
          id: String(te.id || makeId()).trim(),
          label: String(te.label || "Milestone").trim(),
          date: /^\d{4}-\d{2}-\d{2}$/.test(te.date || "") ? te.date : "",
          time: /^\d{2}:\d{2}$/.test(te.time || "") ? te.time : ""
        })).filter(te => te.label && te.date)
      : [];

    const d = prog.details || {};
    // The program's categories: its own list, or one built from the older
    // fields. Unknown ids are kept.
    const taxonomy = Taxonomy.listFor(prog);
    const taxonomyFields = Taxonomy.legacyFields(taxonomy, prog);
    // Documents from the checklist and older ones it no longer lists alike.
    const documents = Array.isArray(prog.documents) ? prog.documents.map((document) => ({
      ...document,
      id: String(document?.id || "").trim(),
      status: PROGRAM_DOCUMENT_STATUSES.includes(document?.status) ? document.status : "Unknown",
      link: cleanStoredLink(document?.link),
      notes: String(document?.notes || "").trim(),
    })).filter((document) => document.id) : [];

    return withTargetFields(prog, {
      id: String(prog.id || makeId()).trim() || makeId(),
      name: String(prog.name || "Untitled Opportunity").trim() || "Untitled Opportunity",
      taxonomy,
      category: taxonomyFields.category,
      subcategory: taxonomyFields.subcategory,
      type: taxonomyFields.type,
      applicationName: String(prog.applicationName || "").trim(),
      applicationLink: cleanStoredLink(prog.applicationLink || prog.details?.appUrl),
      recordKind: prog.recordKind === "watchlist" ? "watchlist" : "opportunity",
      campaignId: normalizeCampaignId(prog.campaignId),
      nextActionDate: /^\d{4}-\d{2}-\d{2}$/.test(prog.nextActionDate || d.actionDeadline || "") ? (prog.nextActionDate || d.actionDeadline) : "",
      nextActionTime: /^\d{2}:\d{2}$/.test(prog.nextActionTime || "") ? prog.nextActionTime : "",
      status,
      priority,
      notes: String(prog.notes || "").trim(),
      tags: normalizeTagArray(prog.tags),
      documents,
      extraParams: filterRetiredExtraParams(prog.extraParams || {}),
      timeEntries,
      activityLog: Array.isArray(prog.activityLog)
        ? prog.activityLog.map(normalizeProgramActivity).filter(Boolean)
        : [],
      details: cleanDetails(d),
      deletedAt: prog.deletedAt || "",
      createdAt: prog.createdAt || now,
      updatedAt: prog.updatedAt || now
    });
  }

  function normalizeFundingRound(round) {
    if (!round || typeof round !== "object") return null;
    const now = new Date().toISOString();
    return {
      id: String(round.id || makeId()).trim() || makeId(),
      name: String(round.name || "Untitled round").trim() || "Untitled round",
      stage: String(round.stage || "").trim(),
      targetAmount: Math.max(0, Number(round.targetAmount) || 0),
      minimumClose: Math.max(0, Number(round.minimumClose) || 0),
      currency: String(round.currency || "EUR").trim().toUpperCase() || "EUR",
      expectedCloseDate: /^\d{4}-\d{2}-\d{2}$/.test(round.expectedCloseDate || "") ? round.expectedCloseDate : "",
      notes: String(round.notes || "").trim(),
      createdAt: round.createdAt || now,
      updatedAt: round.updatedAt || now,
    };
  }

  function normalizeFundingSource(fund) {
    if (!fund || typeof fund !== "object") return null;
    const now = new Date().toISOString();
    const status = typeof fund.status === "string" && fund.status ? fund.status : Statuses.defaultStatus();
    const priority = ["Very High", "High", "Medium", "Low", "Very Low"].includes(fund.priority) ? fund.priority : "Medium";
    
    const commitments = Array.isArray(fund.commitments)
      ? fund.commitments.map((c) => {
          const legacyType = String(c.type || "").trim();
          const allowedStates = ["Verbal", "Written", "Conditional", "Signed"];
          const stateValue = allowedStates.includes(c.state) ? c.state : (allowedStates.includes(legacyType) ? legacyType : "Verbal");
          const instrument = String(c.instrument || (allowedStates.includes(legacyType) ? "" : legacyType)).trim();
          return {
            id: String(c.id || makeId()).trim(),
            amount: Number(c.amount) || 0,
            currency: String(c.currency || "EUR").trim().toUpperCase(),
            state: stateValue,
            instrument,
            type: instrument || stateValue,
            date: /^\d{4}-\d{2}-\d{2}$/.test(c.date || "") ? c.date : "",
            notes: String(c.notes || "").trim()
          };
        }).filter(c => c.amount > 0)
      : [];

    const payments = Array.isArray(fund.payments)
      ? fund.payments.map((p) => ({
          id: String(p.id || makeId()).trim(),
          amount: Number(p.amount) || 0,
          currency: String(p.currency || "EUR").trim().toUpperCase(),
          status: ["Expected", "Scheduled", "Partially Received", "Received", "Invoiced", "Delayed", "Cancelled"].includes(p.status) ? p.status : "Expected",
          date: /^\d{4}-\d{2}-\d{2}$/.test(p.date || "") ? p.date : "",
          receivedDate: /^\d{4}-\d{2}-\d{2}$/.test(p.receivedDate || "") ? p.receivedDate : "",
          reference: String(p.reference || "").trim(),
          linkedProgramId: String(p.linkedProgramId || "").trim(),
          notes: String(p.notes || "").trim()
        })).filter(p => p.amount > 0)
      : [];

    const fundingTaxonomy = Taxonomy.listFor(fund);
    const fundingTaxonomyFields = Taxonomy.legacyFields(fundingTaxonomy, fund);

    return withTargetFields(fund, {
      id: String(fund.id || makeId()).trim() || makeId(),
      funder: String(fund.funder || "Untitled Funder").trim() || "Untitled Funder",
      funderLink: cleanStoredLink(fund.funderLink),
      opportunity: String(fund.opportunity || "Untitled Opportunity").trim() || "Untitled Opportunity",
      taxonomy: fundingTaxonomy,
      category: fundingTaxonomyFields.category,
      subcategory: fundingTaxonomyFields.subcategory,
      type: fundingTaxonomyFields.type,
      // The free-text source type of older records, shown until it is mapped.
      sourceType: String(fund.sourceType || "").trim(),
      campaignId: normalizeCampaignId(fund.campaignId),
      roundId: String(fund.roundId || "").trim(),
      nextActionDate: /^\d{4}-\d{2}-\d{2}$/.test(fund.nextActionDate || "") ? fund.nextActionDate : "",
      nextActionTime: /^\d{2}:\d{2}$/.test(fund.nextActionTime || "") ? fund.nextActionTime : "",
      nextAction: String(fund.nextAction || "").trim(),
      owner: String(fund.owner || fund.actionOwner || "").trim(),
      contactName: String(fund.contactName || "").trim(),
      contactRole: String(fund.contactRole || "").trim(),
      contactEmail: String(fund.contactEmail || "").trim(),
      introducer: String(fund.introducer || "").trim(),
      lastContactDate: /^\d{4}-\d{2}-\d{2}$/.test(fund.lastContactDate || "") ? fund.lastContactDate : "",
      // Empty is unknown; 0 is an ask of nothing.
      askAmount: fund.askAmount === null || fund.askAmount === undefined || fund.askAmount === "" ? null : Math.max(0, Number(fund.askAmount) || 0),
      askCurrency: String(fund.askCurrency || "EUR").trim().toUpperCase() || "EUR",
      probability: fund.probability === null || fund.probability === undefined || fund.probability === "" ? null : Math.min(100, Math.max(0, Number(fund.probability) || 0)),
      expectedCloseDate: /^\d{4}-\d{2}-\d{2}$/.test(fund.expectedCloseDate || "") ? fund.expectedCloseDate : "",
      lossReason: String(fund.lossReason || "").trim(),
      status,
      priority,
      notes: String(fund.notes || "").trim(),
      tags: normalizeTagArray(fund.tags),
      extraParams: filterRetiredExtraParams(fund.extraParams || {}),
      commitments,
      payments,
      deletedAt: fund.deletedAt || "",
      createdAt: fund.createdAt || now,
      updatedAt: fund.updatedAt || now
    });
  }

  function filterRetiredExtraParams(extraParams, retired = RETIRED_EXTRA_PARAM_IDS) {
    const rawExtra = extraParams && typeof extraParams === "object" ? extraParams : {};
    const filtered = {};
    Object.keys(rawExtra).forEach((key) => {
      const normalizedKey = String(key);
      if (Object.prototype.hasOwnProperty.call(rawExtra, key) && !retired.has(normalizedKey)) {
        filtered[normalizedKey] = String(rawExtra[key] ?? "");
      }
    });
    return filtered;
  }

  // ---- What every target keeps (js/fields.js) ----------------------------------
  //
  // The normalizers below set the fields each section has always had. Every
  // target also keeps the fields the target window added (organization, next
  // action, deadline, owner, its detail and custom fields, milestones and the
  // update log), and any key nobody knows, so a field from an older version or
  // an import is never lost on save; the window lists those under "Other
  // fields". Fields that became links (js/links-model.js) are dropped.
  const DROPPED_TARGET_KEYS = new Set(["linkedProgramIds", "linkedFundingIds", "linkedMediaIds", "linkedTargetIds", "linkedProgramId"]);

  function cleanDetails(details) {
    const out = {};
    for (const [key, value] of Object.entries(details && typeof details === "object" ? details : {})) {
      if (value === null || value === undefined || value === "") continue;
      out[key] = value;
    }
    return out;
  }

  function normalizeTimeEntries(entries) {
    return (Array.isArray(entries) ? entries : [])
      .map((entry) => ({
        ...entry,
        id: String(entry?.id || makeId()).trim(),
        label: String(entry?.label || "Milestone").trim(),
        date: /^\d{4}-\d{2}-\d{2}$/.test(entry?.date || "") ? entry.date : "",
        time: /^\d{2}:\d{2}$/.test(entry?.time || "") ? entry.time : "",
      }))
      .filter((entry) => entry.label && entry.date);
  }

  function withTargetFields(raw, normalized) {
    const kept = {};
    for (const [key, value] of Object.entries(raw || {})) {
      if (value === undefined || DROPPED_TARGET_KEYS.has(key) || key in normalized) continue;
      kept[key] = value;
    }
    const text = (key) => String(raw?.[key] ?? normalized[key] ?? "").trim();
    const extra = {};
    for (const key of ["organization", "nextAction", "owner"]) if (text(key)) extra[key] = text(key);
    const deadline = Fields.normalize({ type: "datetime" }, raw?.deadline);
    if (deadline) extra.deadline = deadline;
    const details = cleanDetails(normalized.details || raw?.details);
    if (Object.keys(details).length) extra.details = details;
    const custom = cleanDetails(raw?.custom);
    if (Object.keys(custom).length) extra.custom = custom;
    const timeEntries = normalizeTimeEntries(normalized.timeEntries || raw?.timeEntries);
    if (timeEntries.length) extra.timeEntries = timeEntries;
    const activityLog = (Array.isArray(raw?.activityLog) ? raw.activityLog : []).map(normalizeProgramActivity).filter(Boolean);
    if (activityLog.length) extra.activityLog = activityLog;
    if (!("repeatInterval" in normalized) && Number(raw?.repeatInterval) > 0 && ["days", "weeks", "months"].includes(raw?.repeatUnit)) {
      extra.repeatInterval = parseInt(raw.repeatInterval, 10);
      extra.repeatUnit = raw.repeatUnit;
    }
    return { ...kept, ...normalized, ...extra };
  }

  function normalizeItem(item) {
    if (!item || typeof item !== "object") return null;

    // Ids the lists do not know are kept and saved back unchanged: a category,
    // subcategory or status is never silently swapped for the first one.
    const taxonomy = Taxonomy.listFor(item);
    const { category, subcategory, subcategories, type } = Taxonomy.legacyFields(taxonomy, item);

    const finalStatus = typeof item.status === "string" && item.status ? item.status : Statuses.defaultStatus();
    const priority = ["Very High", "High", "Medium", "Low", "Very Low"].includes(item.priority) ? item.priority : "Medium";

    const rawTags = Array.isArray(item.tags) ? item.tags : [];
    const tags = Array.from(
      new Set(
        rawTags
          .map((t) => String(t || "").trim().toLowerCase())
          .filter((t) => t.length > 0 && t.length <= 60),
      ),
    );

    const rawExtra = item.extraParams && typeof item.extraParams === "object" ? item.extraParams : {};
    const extraParams = filterRetiredExtraParams(rawExtra, RETIRED_TARGET_EXTRA_PARAM_IDS);

    return withTargetFields(item, {
      id: String(item.id || makeId()),
      campaignId: normalizeCampaignId(item.campaignId),
      taxonomy,
      category,
      subcategory,
      subcategories,
      type,
      platform: String(item.platform || "Untitled target").trim() || "Untitled target",
      link: cleanStoredLink(item.link),
      status: finalStatus,
      date: /^\d{4}-\d{2}-\d{2}$/.test(item.date || "") ? item.date : "",
      time: /^\d{2}:\d{2}$/.test(item.time || "") ? item.time : nowDateTimeParts().time,
      priority,
      tags,
      extraParams,
      notes: String(item.notes || "").trim(),
      repeatInterval: item.repeatInterval ? parseInt(item.repeatInterval, 10) : 0,
      repeatUnit: ["days", "weeks", "months"].includes(item.repeatUnit) ? item.repeatUnit : "",
      hasRepeated: !!item.hasRepeated,
      deletedAt: item.deletedAt || "",
      createdAt: item.createdAt || new Date().toISOString(),
      updatedAt: item.updatedAt || new Date().toISOString(),
    });
  }

  function render() {
    renderGlobalSearch();
    renderAppTabs();
    renderProjectLinksMenu();

    // The add forms' lists (statuses, campaigns) follow edits made elsewhere.
    Object.values(sectionPages).forEach((page) => page.renderForm());
    const activeTab = state.selectedAppTab || "calendar";
    if (activeTab === "pipeline") {
      renderSectionPage("mk");
    } else if (activeTab === "programs") {
      renderSectionPage("po");
    } else if (activeTab === "funding") {
      renderSectionPage("fu");
      renderFundingRounds();
    } else if (activeTab === "calendar") {
      renderCalendarTab();
    } else if (activeTab === "company") {
      companyPage()?.render();
    } else if (activeTab === "agents") {
      agentsPage()?.render();
    } else if (activeTab === "extra" || ["ai", "media", "feedback", "campaigns", "tags", "research", "prompts"].includes(activeTab)) {
      renderExtraTab();
    }

    applyPanelCollapseState();
    // Open parts of the page outside app.js (the Settings panel's recycle
    // bin) follow the data.
    window.dispatchEvent(new CustomEvent("startup-tracker:data"));
  }

  // ---- Extra pages ------------------------------------------------------------
  //
  // Every page starts with the same header (title, count, filter, Add) and
  // shows the same kind of empty state. Option lists are edited on the page
  // that uses them (js/options-editor.js).

  function extraEmptyStateHtml(title, hint) {
    return `<div class="empty-state compact extra-empty"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(hint)}</p></div>`;
  }

  function setExtraCount(page, count) {
    const node = document.querySelector(`[data-extra-count="${page}"]`);
    if (node) node.textContent = t("extra.count", { count });
  }

  function focusExtraForm(input) {
    if (!input) return;
    input.scrollIntoView({ block: "center", behavior: "smooth" });
    input.focus({ preventScroll: true });
  }

  // Where Add takes you on each page.
  const EXTRA_ADD_ACTIONS = Object.freeze({
    ai: () => addAiAccount(),
    media: () => focusExtraForm(elements.mediaTitleInput),
    feedback: () => focusExtraForm(elements.feedbackTitleInput),
    research: () => focusExtraForm(elements.dailyTitleInput),
    campaigns: () => focusExtraForm(elements.campaignNameInput),
    tags: () => focusExtraForm(elements.tagLabelInput),
  });

  // The pages whose count is not set by their own list.
  const EXTRA_COUNTS = Object.freeze({
    // Built-in prompts and yours; the page reports the number once loaded.
    prompts: () => state.prompts.length,
    categories: () => ["mk", "po", "fu"].reduce((sum, section) => sum + Taxonomy.categories(section).length, 0),
    fields: () => ["mk", "po", "fu"].reduce((sum, section) => sum + Fields.customFields(section).length, 0),
  });

  const EXTRA_OPTION_LISTS = Object.freeze({
    media: ["mediaTypes"],
    feedback: ["feedbackTypes", "feedbackSources", "feedbackStages", "feedbackAreas", "feedbackEvidence", "feedbackRelationships", "feedbackJourneySteps", "feedbackVerdicts"],
    research: ["researchGroups"],
    fields: ["documentChecklist"],
  });

  function renderExtraOptionEditors(page) {
    const holder = document.querySelector(`[data-options-editor="${page}"]`);
    if (!holder || !EXTRA_OPTION_LISTS[page] || holder.dataset.mounted === "1") return;
    holder.dataset.mounted = "1";
    window.StartupTrackerOptionsEditor?.render(holder, EXTRA_OPTION_LISTS[page], {
      onSaved: () => {
        applyOptionLists();
        markDataChanged();
        render();
      },
    });
  }

  function bindExtraHeaders() {
    elements.extraView?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-extra-add]");
      if (button) EXTRA_ADD_ACTIONS[button.dataset.extraAdd]?.();
    });
    const filters = [
      [elements.aiSearchInput, "aiSearch", () => renderAiGroups()],
      [elements.feedbackSearchInput, "feedbackSearch", () => {
        state.feedbackPage = 1;
        renderFeedbackList();
      }],
      [elements.dailySearchInput, "dailySearch", () => renderDailyGroups()],
    ];
    filters.forEach(([input, key, draw]) => {
      input?.addEventListener("input", () => {
        state[key] = input.value.trim();
        draw();
      });
    });
    elements.aiRate?.addEventListener("change", (event) => {
      if (event.target.matches("[data-ai-rate]")) updateAiRate(event.target.value);
    });
  }

  function renderExtraTab() {
    const activeSubTab = state.selectedExtraSubTab || "ai";

    const subnavBtns = document.querySelectorAll(".extra-subnav-btn[data-extra-tab]");
    subnavBtns.forEach((btn) => {
      const isSubActive = btn.dataset.extraTab === activeSubTab;
      btn.classList.toggle("active", isSubActive);
      btn.setAttribute("aria-selected", isSubActive ? "true" : "false");
    });

    const extraButton = elements.appTabs?.querySelector('[data-app-tab="extra"]');
    if (extraButton) {
      extraButton.dataset.activeSubtab = activeSubTab;
    }

    const aiPage = document.querySelector("#extraSubpageAi");
    const mediaPage = document.querySelector("#extraSubpageMedia");
    const feedbackPage = document.querySelector("#extraSubpageFeedback");
    const campaignsPage = document.querySelector("#extraSubpageCampaigns");
    const tagsPage = document.querySelector("#extraSubpageTags");
    const researchPage = document.querySelector("#extraSubpageResearch") || document.querySelector("#ocSubpageResearch");
    const promptsSubpage = document.querySelector("#extraSubpagePrompts");
    const categoriesPage = document.querySelector("#extraSubpageCategories");
    if (categoriesPage) categoriesPage.style.display = activeSubTab === "categories" ? "" : "none";
    const fieldsPage = document.querySelector("#extraSubpageFields");
    if (fieldsPage) fieldsPage.style.display = activeSubTab === "fields" ? "" : "none";

    if (aiPage) aiPage.style.display = activeSubTab === "ai" ? "" : "none";
    if (mediaPage) mediaPage.style.display = activeSubTab === "media" ? "" : "none";
    if (feedbackPage) feedbackPage.style.display = activeSubTab === "feedback" ? "" : "none";
    if (campaignsPage) campaignsPage.style.display = activeSubTab === "campaigns" ? "" : "none";
    if (tagsPage) tagsPage.style.display = activeSubTab === "tags" ? "" : "none";
    if (researchPage) researchPage.style.display = activeSubTab === "research" ? "" : "none";
    if (promptsSubpage) promptsSubpage.style.display = activeSubTab === "prompts" ? "" : "none";

    document.documentElement.setAttribute("data-active-app-tab", activeSubTab);

    if (activeSubTab === "ai") {
      renderAiGroups();
      renderAiFlow();
    } else if (activeSubTab === "media") {
      renderMediaControls();
      renderMediaList();
    } else if (activeSubTab === "feedback") {
      renderFeedbackControls();
      feedbackAboutPicker();
      renderFeedbackList();
    } else if (activeSubTab === "campaigns") {
      renderCampaigns();
    } else if (activeSubTab === "tags") {
      renderTags();
    } else if (activeSubTab === "research") {
      renderDailyFormOptions();
      renderDailyGroups();
    } else if (activeSubTab === "prompts") {
      promptsPage()?.render();
    } else if (activeSubTab === "categories") {
      window.StartupTrackerCategoriesEditor?.render(document.querySelector("#categoriesEditor"));
    } else if (activeSubTab === "fields") {
      window.StartupTrackerFieldsEditor?.render(document.querySelector("#fieldsEditor"));
    }
    if (EXTRA_COUNTS[activeSubTab]) setExtraCount(activeSubTab, EXTRA_COUNTS[activeSubTab]());
    renderExtraOptionEditors(activeSubTab);
    setTimeout(() => autoResizeAllModalTextareas(), 0);
  }

  function renderAppTabs() {
    if (["ai", "media", "feedback", "campaigns", "tags", "research", "prompts"].includes(state.selectedAppTab)) {
      state.selectedExtraSubTab = state.selectedAppTab;
      state.selectedAppTab = "extra";
    }

    const activeTab = state.selectedAppTab || "calendar";
    const activeAttr = activeTab === "extra" ? (state.selectedExtraSubTab || "ai") : activeTab;
    document.documentElement.setAttribute("data-active-app-tab", activeAttr);

    elements.appTabs.querySelectorAll("[data-app-tab]").forEach((button) => {
      const isActive = button.dataset.appTab === activeTab;
      if (isActive && elements.breadcrumbView) elements.breadcrumbView.textContent = button.textContent.trim();
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-selected", String(isActive));
      if (button.dataset.appTab === "extra") {
        button.dataset.activeSubtab = state.selectedExtraSubTab || "ai";
      }
    });

    elements.appViews.forEach((view) => {
      const isActive = view.dataset.appView === activeTab;
      view.classList.toggle("active", isActive);
      view.hidden = !isActive;
    });

    if (activeTab === "extra") {
      renderExtraTab();
    }
  }

  // ---- Feedback blocks ------------------------------------------------------
  //
  // Each feedback type (Feedback > Options) may open one of three blocks of
  // extra fields. A block with values always shows, whatever the type, so
  // changing the type never hides what was written.

  const FEEDBACK_BLOCKS = Object.freeze({
    person: {
      get title() { return t("app.feedbackBlocks.personAndContext"); },
      get hint() { return t("app.feedbackBlocks.whoThisCameFromAnd"); },
      fields: [
        { key: "userRole", get label() { return t("app.feedbackBlocks.role"); }, kind: "text", get placeholder() { return t("app.feedbackBlocks.eGFounderOfficeManager"); } },
        { key: "teamContext", get label() { return t("app.feedbackBlocks.companyOrTeam"); }, kind: "text", get placeholder() { return t("app.feedbackBlocks.eGA10Person"); } },
        { key: "currentAlternative", get label() { return t("app.feedbackBlocks.whatTheyUseToday"); }, kind: "text", get placeholder() { return t("app.feedbackBlocks.eGASpreadsheetA"); } },
        { key: "nextActionDate", get label() { return t("app.feedbackBlocks.nextContactDate"); }, kind: "date" },
        { key: "useCase", get label() { return t("app.feedbackBlocks.whatTheyWantToGet"); }, kind: "textarea", get placeholder() { return t("app.feedbackBlocks.eGSendInvoicesWithout"); } },
      ],
    },
    journey: {
      get title() { return t("app.feedbackBlocks.journey"); },
      get hint() { return t("app.feedbackBlocks.howFarTheyGotWhether"); },
      fields: [
        { key: "journeyStep", get label() { return t("app.feedbackBlocks.furthestStepReached"); }, kind: "select", list: "feedbackJourneySteps", get emptyLabel() { return t("app.feedbackBlocks.notTracked"); } },
        { key: "repeatUsageCount", get label() { return t("app.feedbackBlocks.timesUsed"); }, kind: "number", placeholder: "e.g. 3" },
        { key: "dropOffReason", get label() { return t("app.feedbackBlocks.whyTheyStoppedOrHesitated"); }, kind: "textarea", get placeholder() { return t("app.feedbackBlocks.eGCouldNotConnect"); } },
      ],
    },
    assumption: {
      get title() { return t("app.feedbackBlocks.assumptionTest"); },
      get hint() { return t("app.feedbackBlocks.aBeliefTheStartupDepends"); },
      fields: [
        { key: "hypothesis", get label() { return t("app.feedbackBlocks.assumption"); }, kind: "textarea", get placeholder() { return t("app.feedbackBlocks.eGSmallAgenciesWill"); } },
        { key: "evidenceFor", get label() { return t("app.feedbackBlocks.evidenceFor"); }, kind: "textarea" },
        { key: "evidenceAgainst", get label() { return t("app.feedbackBlocks.evidenceAgainst"); }, kind: "textarea" },
        { key: "verdict", get label() { return t("app.feedbackBlocks.verdict"); }, kind: "select", list: "feedbackVerdicts", emptyLabel: "" },
        { key: "nextReviewDate", get label() { return t("app.feedbackBlocks.nextReviewDate"); }, kind: "date" },
      ],
    },
  });

  function feedbackBlockOfType(type) {
    return Options.find("feedbackTypes", type)?.block || "";
  }

  function feedbackBlockHasValues(name, item) {
    return FEEDBACK_BLOCKS[name].fields.some((field) => {
      const value = item?.[field.key];
      if (field.key === "verdict") return Boolean(value) && value !== "untested";
      return value !== undefined && value !== null && String(value).trim() !== "";
    });
  }

  // The blocks an item shows: its type's block, then any other with values.
  function feedbackBlocksFor(item) {
    const own = feedbackBlockOfType(item.type);
    return Object.keys(FEEDBACK_BLOCKS).filter((name) => name === own || feedbackBlockHasValues(name, item));
  }

  // The inputs of one block. On a card they save as they change
  // (data-feedback-field); in the add form they are read on submit.
  function feedbackBlockHtml(name, item, { card = false } = {}) {
    const block = FEEDBACK_BLOCKS[name];
    const id = escapeAttribute(item.id || "");
    const attrs = (field) => (card ? `data-feedback-field="${field.key}" data-id="${id}"` : `data-feedback-form-field="${field.key}"`);
    const input = (field) => {
      const value = item[field.key] ?? "";
      const placeholder = field.placeholder ? ` placeholder="${escapeAttribute(field.placeholder)}"` : "";
      if (field.kind === "select") {
        return `<select class="row-select" ${attrs(field)}>${Options.optionsHtml(field.list, value, { emptyLabel: field.emptyLabel })}</select>`;
      }
      if (field.kind === "textarea") {
        return `<textarea class="auto-expand-field" rows="2" ${attrs(field)}${placeholder}>${escapeHtml(value)}</textarea>`;
      }
      const type = field.kind === "number" ? `number" min="0" step="1` : field.kind;
      return `<input class="inline-input" type="${type}" value="${escapeAttribute(value)}" ${attrs(field)}${placeholder}>`;
    };
    return `
      <div class="wide-field feedback-strategy-block" data-feedback-block="${name}">
        <div class="feedback-strategy-title">${escapeHtml(block.title)}</div>
        <p class="feedback-form-subhint">${escapeHtml(block.hint)}</p>
        <div class="feedback-strategy-grid">
          ${block.fields.filter((field) => field.kind !== "textarea").map((field) => `<label>${escapeHtml(field.label)}${input(field)}</label>`).join("")}
        </div>
        ${block.fields.filter((field) => field.kind === "textarea").map((field) => `<label class="wide-field">${escapeHtml(field.label)}${input(field)}</label>`).join("")}
      </div>`;
  }

  // What a read-only card shows of its blocks.
  function feedbackBlockSummaryHtml(item) {
    return feedbackBlocksFor(item).map((name) => {
      const block = FEEDBACK_BLOCKS[name];
      const short = [];
      const long = [];
      block.fields.forEach((field) => {
        const value = item[field.key];
        if (value === undefined || value === null || String(value).trim() === "") return;
        if (field.kind === "textarea") {
          long.push(`<div class="feedback-outcome-block"><div class="action-title">${escapeHtml(field.label)}</div><div class="action-content markdown-rendered">${renderMarkdown(value)}</div></div>`);
          return;
        }
        const shown = field.kind === "select" ? Options.label(field.list, value) : field.kind === "date" ? formatDate(value) : String(value);
        short.push(`<span><strong>${escapeHtml(field.label)}:</strong> ${escapeHtml(shown)}</span>`);
      });
      if (!short.length && !long.length) return "";
      return `${short.length ? `<div class="feedback-strategy-summary" data-feedback-summary="${name}">${short.join("")}</div>` : ""}${long.join("")}`;
    }).join("");
  }

  // The add form's lists, its block for the chosen type, and the filters, all
  // from the shared option lists.
  function renderFeedbackControls() {
    const formControls = [
      [elements.feedbackTypeInput, "feedbackTypes", "feedback"],
      [elements.feedbackSourceInput, "feedbackSources", "other"],
      [elements.feedbackStageInput, "feedbackStages", "unknown"],
      [elements.feedbackAreaInput, "feedbackAreas", "other"],
      [elements.feedbackEvidenceInput, "feedbackEvidence", "anecdote"],
      [elements.feedbackRelationshipInput, "feedbackRelationships", "none"],
    ];
    formControls.forEach(([select, list, fallback]) => {
      if (!select) return;
      const current = select.value || fallback;
      const ids = Options.list(list).map((option) => option.id);
      const selected = ids.includes(current) ? current : ids.includes(fallback) ? fallback : ids[0] || "";
      select.innerHTML = Options.optionsHtml(list, selected);
      select.value = selected;
    });
    if (elements.feedbackStatusInput) {
      const current = elements.feedbackStatusInput.value || "new";
      elements.feedbackStatusInput.innerHTML = feedbackStatuses.map((status) => `<option value="${status}" ${status === current ? "selected" : ""}>${escapeHtml(status)}</option>`).join("");
    }
    renderFeedbackFormBlock();

    const filterControls = [
      [elements.feedbackTypeFilter, "feedbackTypes", "feedbackTypeFilter", t("app.renderFeedbackControls.allTypes")],
      [elements.feedbackStageFilter, "feedbackStages", "feedbackStageFilter", t("app.renderFeedbackControls.allStages")],
      [elements.feedbackEvidenceFilter, "feedbackEvidence", "feedbackEvidenceFilter", t("app.renderFeedbackControls.allEvidenceLevels")],
    ];
    filterControls.forEach(([select, list, stateKey, allLabel]) => {
      if (!select) return;
      const current = state[stateKey] || "all";
      select.innerHTML = Options.optionsHtml(list, current, { allLabel });
      select.value = current;
    });
  }

  // The add form shows the block of the chosen type, keeping what was typed
  // in fields the next block shares.
  function renderFeedbackFormBlock() {
    const holder = elements.feedbackBlockFields;
    if (!holder) return;
    const typed = readFeedbackFormBlock();
    const name = feedbackBlockOfType(elements.feedbackTypeInput?.value || "");
    if (holder.dataset.block === name) return;
    holder.dataset.block = name;
    holder.innerHTML = name ? feedbackBlockHtml(name, typed) : "";
  }

  function readFeedbackFormBlock() {
    const values = {};
    elements.feedbackBlockFields?.querySelectorAll("[data-feedback-form-field]").forEach((input) => {
      values[input.dataset.feedbackFormField] = input.value;
    });
    return values;
  }

  // The "About" picker of the add form: the records this feedback is about.
  let feedbackAboutPickerInstance = null;
  function feedbackAboutPicker() {
    if (!feedbackAboutPickerInstance && elements.feedbackAboutInput) {
      feedbackAboutPickerInstance = createItemPicker(elements.feedbackAboutInput, {
        kinds: ["mk", "po", "fu", "campaign"],
        label: t("app.feedbackAboutPicker.about"),
        placeholder: t("app.feedbackAboutPicker.targetsProgramsFunding"),
        recentName: "feedback-about",
      });
    }
    return feedbackAboutPickerInstance || { getValue: () => [], setValue: () => {} };
  }

  // The "About" picker of the feedback card being edited.
  function mountFeedbackAboutPicker() {
    const holder = elements.feedbackList?.querySelector("[data-feedback-about]");
    if (!holder) return;
    const feedbackId = holder.dataset.feedbackAbout;
    createItemPicker(holder, {
      kinds: ["mk", "po", "fu", "campaign"],
      label: t("app.mountFeedbackAboutPicker.about"),
      placeholder: t("app.mountFeedbackAboutPicker.targetsProgramsFunding"),
      recentName: "feedback-about",
      value: linkedRefs("feedback", feedbackId, "feedback-about", "a"),
      onChange: (refs) => {
        setLinkedRefs("feedback", feedbackId, "feedback-about", "a", refs);
        const item = findFeedbackItem(feedbackId);
        if (item) item.updatedAt = new Date().toISOString();
        persist(t("app.mountFeedbackAboutPicker.feedbackLinksUpdated"));
      },
    });
  }

  function renderCampaignStatusFilters() {
    if (!elements.campaignStatusFilters) return;

    elements.campaignStatusFilters.innerHTML = Statuses.campaignStatuses()
      .map(({ id: status, label }) => {
        const isSelected = state.campaignStatusFilter.includes(status);
        return `
          <button type="button" class="filter-pill ${isSelected ? "active" : ""}" aria-pressed="${isSelected}" data-status="${escapeAttribute(status)}">
            ${escapeHtml(label)}
          </button>
        `;
      })
      .join("");
  }

  function renderCampaigns() {
    setExtraCount("campaigns", state.campaigns.length);
    renderCampaignStatusFilters();
    renderCampaignTagFilters();
    renderTagDatalist(tagDatalistId("campaign"));
    if (!elements.campaignList) return;

    if (!state.campaigns.length) {
      elements.campaignList.innerHTML = extraEmptyStateHtml(t("extra.campaigns.emptyTitle"), t("extra.campaigns.emptyHint"));
      renderManagerPagination(elements.campaignPagination, 0, "campaignPage");
      return;
    }

    const filtered = state.campaigns.filter((campaign) => {
      if (state.campaignStatusFilter.length > 0 && !state.campaignStatusFilter.includes(campaign.status)) {
        return false;
      }
      if (state.campaignTagFilter.length > 0) {
        const campaignTags = campaign.tags || [];
        if (!state.campaignTagFilter.every((f) => campaignTags.includes(f))) {
          return false;
        }
      }
      if (state.campaignSearch) {
        const query = state.campaignSearch.toLowerCase();
        return (
          (campaign.name || "").toLowerCase().includes(query) ||
          (campaign.goal || "").toLowerCase().includes(query) ||
          (campaign.hypothesis || "").toLowerCase().includes(query) ||
          (campaign.description || "").toLowerCase().includes(query)
        );
      }
      return true;
    });

    if (!filtered.length) {
      elements.campaignList.innerHTML = extraEmptyStateHtml(t("extra.noMatchTitle"), t("extra.noMatchHint"));
      renderManagerPagination(elements.campaignPagination, 0, "campaignPage");
      return;
    }

    const ordered = filtered
      .slice()
      .sort((a, b) => campaignStatusWeight(a.status) - campaignStatusWeight(b.status) || String(a.startDate || "").localeCompare(String(b.startDate || "")) || a.name.localeCompare(b.name));
    const paged = getManagerPageItems(ordered, "campaignPage");

    elements.campaignList.innerHTML = paged
      .map((campaign) => {
        const linkedCount = countCampaignItems(campaign.id);
        const isEditing = state.editingCampaignId === campaign.id;

        if (isEditing) {
          return `
            <article class="manager-card editing-card" data-campaign-id="${escapeAttribute(campaign.id)}">
              <div class="manager-card-header">
                <div>
                  <strong style="color: var(--accent);">${tHtml("app.renderCampaigns.editingCampaign", { name: escapeHtml(campaign.name) })}</strong>
                  <span>${escapeHtml(t("app.renderCampaigns.changesAreSavedAutomatically"))}</span>
                </div>
                <div class="card-actions">
                  <button class="icon-button success-btn" type="button" data-tooltip="${escapeAttribute(t("app.renderCampaigns.doneEditing"))}" aria-label="${escapeAttribute(t("app.renderCampaigns.doneEditing"))}" data-campaign-action="done" data-id="${escapeAttribute(campaign.id)}">
                    <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                  </button>
                </div>
              </div>
              <div class="manager-card-grid">
                <label>
                  ${escapeHtml(t("ui.common.name"))}
                  <input class="inline-input" type="text" value="${escapeAttribute(campaign.name)}" data-campaign-field="name" data-id="${escapeAttribute(campaign.id)}">
                </label>
                <label>
                  ${escapeHtml(t("ui.common.status"))}
                  <select class="row-select" data-campaign-field="status" data-id="${escapeAttribute(campaign.id)}">
                    ${campaignStatusOptions(campaign.status)}
                  </select>
                </label>
                <div class="field-group row-align">
                  <label>${escapeHtml(t("app.renderCampaigns.start"))}</label>
                  <input class="inline-input custom-date-input" type="date" value="${escapeAttribute(campaign.startDate)}" data-date="${escapeAttribute(formatDate(campaign.startDate))}" data-campaign-field="startDate" data-id="${escapeAttribute(campaign.id)}">
                </div>
                <div class="field-group row-align">
                  <label>${escapeHtml(t("app.renderCampaigns.end"))}</label>
                  <input class="inline-input custom-date-input" type="date" value="${escapeAttribute(campaign.endDate)}" data-date="${escapeAttribute(formatDate(campaign.endDate))}" data-campaign-field="endDate" data-id="${escapeAttribute(campaign.id)}">
                </div>
                <label class="wide-field">
                  ${escapeHtml(t("app.renderCampaigns.goal"))}
                  <input class="inline-input" type="text" value="${escapeAttribute(campaign.goal)}" data-campaign-field="goal" data-id="${escapeAttribute(campaign.id)}">
                </label>
                <label class="wide-field">
                  ${escapeHtml(t("app.renderCampaigns.hypothesis"))}
                  <textarea class="auto-expand-field" data-campaign-field="hypothesis" data-id="${escapeAttribute(campaign.id)}" rows="2">${escapeHtml(campaign.hypothesis)}</textarea>
                </label>
                <label class="wide-field">
                  ${escapeHtml(t("app.renderCampaigns.successMetric"))}
                  <input class="inline-input" type="text" value="${escapeAttribute(campaign.successMetric)}" data-campaign-field="successMetric" data-id="${escapeAttribute(campaign.id)}">
                </label>
                <label class="wide-field">
                  ${escapeHtml(t("app.renderCampaigns.description"))}
                  <textarea class="auto-expand-field" data-campaign-field="description" data-id="${escapeAttribute(campaign.id)}" rows="2">${escapeHtml(campaign.description)}</textarea>
                </label>
                <div class="wide-field inline-tags-field">
                  <span class="label-title">${escapeHtml(t("ui.common.tags"))}</span>
                  <div class="inline-tags-row">
                    <div class="tag-pill-list" data-campaign-tags-list data-id="${escapeAttribute(campaign.id)}">
                      ${(campaign.tags || []).map((t) => `<span class="tag-pill"${tagTooltipAttrs(t)}>${escapeHtml(t)}<button type="button" class="tag-remove" data-campaign-tag-remove="${escapeAttribute(t)}" data-id="${escapeAttribute(campaign.id)}" aria-label="${escapeAttribute(t("app.renderCampaigns.removeTag"))}">${escapeHtml(t("app.renderCampaigns.text"))}</button></span>`).join("")}
                    </div>
                    <input class="inline-input inline-tag-input" type="text" data-campaign-tag-input data-id="${escapeAttribute(campaign.id)}" list="${tagDatalistId("campaign")}" placeholder="${escapeAttribute(t("app.renderCampaigns.typeATagPressEnter"))}">
                  </div>
                </div>
              </div>
              ${renderCampaignTargetsSection(campaign)}
            </article>
          `;
        }

        return `
          <article class="manager-card read-only-card" data-campaign-id="${escapeAttribute(campaign.id)}">
            <div class="manager-card-header">
              <div>
                <strong>${escapeHtml(campaign.name)}</strong>
                <div class="card-meta">
                  <span class="status-badge" data-status="${escapeAttribute(campaign.status)}">${escapeHtml(Statuses.campaignStatusLabel(campaign.status))}</span>
                  <span class="meta-item"><svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle></svg> ${escapeHtml(t("app.counts.target", { count: linkedCount }))}</span>
                  ${campaign.startDate || campaign.endDate ? `
                  <span class="meta-item">
                    <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
                    ${escapeHtml(formatDateRange(campaign.startDate, campaign.endDate))}
                  </span>` : ""}
                </div>
              </div>
              <div class="card-actions">
                <button class="icon-button" type="button" data-tooltip="${escapeAttribute(t("app.renderCampaigns.editCampaign"))}" aria-label="${escapeAttribute(t("app.renderCampaigns.editCampaign"))}" data-campaign-action="edit" data-id="${escapeAttribute(campaign.id)}">
                  <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                </button>
                <button class="icon-button danger-hover" type="button" data-tooltip="${escapeAttribute(t("app.renderCampaigns.deleteCampaign"))}" aria-label="${escapeAttribute(t("app.renderCampaigns.deleteCampaign"))}" data-campaign-action="delete" data-id="${escapeAttribute(campaign.id)}">
                  <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
                </button>
              </div>
            </div>
            <div class="campaign-details-grid">
              ${campaign.goal ? `
              <div class="detail-block">
                <div class="block-title">${escapeHtml(t("app.renderCampaigns.goal"))}</div>
                <div class="block-content">${escapeHtml(campaign.goal)}</div>
              </div>` : ""}
              ${campaign.successMetric ? `
              <div class="detail-block highlight-block">
                <div class="block-title">${escapeHtml(t("app.renderCampaigns.successMetric2"))}</div>
                <div class="block-content">${escapeHtml(campaign.successMetric)}</div>
              </div>` : ""}
              ${campaign.hypothesis ? `
              <div class="detail-block wide-block">
                <div class="block-title">${escapeHtml(t("app.renderCampaigns.hypothesis"))}</div>
                <div class="block-content markdown-rendered">${renderMarkdown(campaign.hypothesis)}</div>
              </div>` : ""}
              ${campaign.description ? `
              <div class="detail-block wide-block">
                <div class="block-title">${escapeHtml(t("app.renderCampaigns.description"))}</div>
                <div class="block-content markdown-rendered">${renderMarkdown(campaign.description)}</div>
              </div>` : ""}
              ${(campaign.tags || []).length ? `
              <div class="detail-block wide-block">
                <div class="block-title">${escapeHtml(t("ui.common.tags"))}</div>
                <div class="block-content tag-pill-list">${(campaign.tags || []).map((t) => `<span class="tag-pill tag-pill-readonly"${tagTooltipAttrs(t)}>${escapeHtml(t)}</span>`).join("")}</div>
              </div>` : ""}
            </div>
            ${renderCampaignTargetsSection(campaign)}
          </article>
        `;
      })
      .join("");
    renderManagerPagination(elements.campaignPagination, ordered.length, "campaignPage");
  }

  function renderCampaignTargetsSection(campaign) {
    const id = `campaign-targets:${campaign.id}`;
    const expanded = isLinkedTargetSectionExpanded(id);
    const allTargets = getCampaignItems(campaign.id);
    const filtered = allTargets.filter((item) => {
      if (state.campaignTargetStatusFilter.length > 0 && !state.campaignTargetStatusFilter.includes(Statuses.groupOf(item.status))) return false;
      if (state.campaignTargetPriorityFilter.length > 0 && !state.campaignTargetPriorityFilter.includes(item.priority)) return false;
      return true;
    });
    const hasActiveFilters = state.campaignTargetStatusFilter.length > 0 || state.campaignTargetPriorityFilter.length > 0;

    const groupCounts = Statuses.countByGroup(allTargets);

    const statusPills = Statuses.groups()
      .map((group) => {
        const active = state.campaignTargetStatusFilter.includes(group.id);
        return `<button type="button" class="filter-pill target-filter-pill ${active ? "active" : ""}" aria-pressed="${active}" data-campaign-target-status="${escapeAttribute(group.id)}" title="${escapeAttribute(group.description)}">${escapeHtml(group.label)}</button>`;
      })
      .join("");

    const priorityValues = ["Very High", "High", "Medium", "Low", "Very Low"];
    const priorityPills = priorityValues
      .map((p) => {
        const active = state.campaignTargetPriorityFilter.includes(p);
        return `<button type="button" class="filter-pill target-filter-pill ${active ? "active" : ""}" data-campaign-target-priority="${escapeAttribute(p)}">${escapeHtml(p)}</button>`;
      })
      .join("");

    const filtersHtml = `
      <div class="campaign-target-filters">
        <div class="campaign-target-filter-group">
          <span class="filter-label">${escapeHtml(t("ui.common.status"))}</span>
          ${statusPills}
        </div>
        <div class="campaign-target-filter-group">
          <span class="filter-label">${escapeHtml(t("ui.common.priority"))}</span>
          ${priorityPills}
        </div>
        ${hasActiveFilters ? `<button type="button" class="filter-pill target-filter-pill target-filter-clear" data-campaign-target-clear>${escapeHtml(t("app.renderCampaignTargetsSection.clear"))}</button>` : ""}
      </div>
    `;

    const countLabel = hasActiveFilters ? `${filtered.length}/${allTargets.length}` : `${allTargets.length}`;

    const programRecords = state.programs.filter((program) => program.campaignId === campaign.id);
    const fundingRecords = state.funding.filter((funding) => funding.campaignId === campaign.id);
    const renderManagerCampaignList = (records, owner, emptyText) => records.length
      ? `<div class="linked-target-list">${records.map((record) => {
          const title = owner === "program" ? record.name : record.funder;
          const detail = owner === "program" ? record.applicationName : record.opportunity;
          return `<button class="linked-target-item linked-target-main" type="button" data-manager-open="${owner}" data-id="${escapeAttribute(record.id)}">
            <span class="linked-target-name">${escapeHtml(title)}</span>
            <span class="linked-target-meta">${statusBadgeHtml(record.status)}${detail ? `<span>${escapeHtml(detail)}</span>` : ""}</span>
          </button>`;
        }).join("")}</div>`
      : `<div class="linked-target-empty">${escapeHtml(emptyText)}</div>`;

    return `
      <div class="linked-target-section ${expanded ? "expanded" : "collapsed"}">
        <button
          class="linked-target-toggle campaign-targets-toggle"
          type="button"
          data-linked-target-toggle="${escapeAttribute(id)}"
          aria-expanded="${expanded}"
        >
          <span class="linked-target-section-title">${escapeHtml(t("ui.common.targets"))}</span>
          <div class="campaign-targets-summary">
            ${Statuses.groups().map((group) => `
            <span class="summary-status status-group-${escapeAttribute(group.id.replace(/_/g, "-"))}">
              <span class="status-dot"></span>
              <span class="status-value">${groupCounts[group.id] || 0}</span> <span class="status-label">${escapeHtml(group.label)}</span>
            </span>`).join("")}
          </div>
          <span class="linked-target-count">${countLabel}</span>
          <span class="linked-target-toggle-action">${expanded ? t("app.renderCampaignTargetsSection.hide") : t("app.renderCampaignTargetsSection.show")}</span>
          <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </button>
        ${expanded ? filtersHtml + renderLinkedTargetList(filtered, allTargets.length ? t("app.renderCampaignTargetsSection.noTargetsMatchingFilters") : t("app.renderCampaignTargetsSection.noTargetsLinkedToThis")) : ""}
      </div>
      <div class="linked-target-section linked-media-section">
        <div class="linked-target-section-title">${tHtml("app.renderCampaignTargetsSection.programs", { length: programRecords.length })}</div>
        ${renderManagerCampaignList(programRecords, "program", t("app.renderCampaignTargetsSection.noProgramsLinkedToThis"))}
      </div>
      <div class="linked-target-section linked-media-section">
        <div class="linked-target-section-title">${tHtml("app.renderCampaignTargetsSection.funding", { length: fundingRecords.length })}</div>
        ${renderManagerCampaignList(fundingRecords, "funding", t("app.renderCampaignTargetsSection.noFundingRecordsLinkedTo"))}
      </div>
      ${renderCampaignOtherStartups(campaign)}
    `;
  }

  // ---- Campaign targets in other startups ------------------------------------
  // Campaigns are shared, so a campaign can hold targets of every startup.
  // Those of the other startups are read once per campaign when its card
  // opens (GET /api/all/campaign-targets), each marked with its startup.

  const campaignOtherTargets = new Map();
  const CAMPAIGN_TARGET_TYPES = { mk: "target", po: "program", fu: "funding" };

  async function loadCampaignOtherTargets(campaignId) {
    if (campaignOtherTargets.has(campaignId)) return;
    campaignOtherTargets.set(campaignId, { loading: true, targets: [] });
    try {
      const response = await fetch(Api.urls.campaignTargets(campaignId), { cache: "no-store" });
      const body = await response.json();
      if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
      campaignOtherTargets.set(campaignId, { loading: false, targets: (body.targets || []).filter((target) => target.startup?.id !== STARTUP_ID) });
    } catch (error) {
      campaignOtherTargets.set(campaignId, { loading: false, targets: [], error: error.message });
    }
    if (state.selectedAppTab === "extra" && state.selectedExtraSubTab === "campaigns") renderCampaigns();
  }

  function renderCampaignOtherStartups(campaign) {
    const entry = campaignOtherTargets.get(campaign.id);
    if (!entry) {
      loadCampaignOtherTargets(campaign.id);
      return "";
    }
    if (entry.loading || (!entry.error && !entry.targets.length)) return "";
    const body = entry.error
      ? `<div class="linked-target-empty">${escapeHtml(t("extra.campaigns.otherFailed"))}</div>`
      : `<div class="linked-target-list">${entry.targets.map((target) => `
          <button class="linked-target-item linked-target-main" type="button" data-campaign-other-open="${escapeAttribute(target.startup.id)}" data-type="${escapeAttribute(CAMPAIGN_TARGET_TYPES[target.section] || "target")}" data-id="${escapeAttribute(target.id)}">
            <span class="linked-target-name">${escapeHtml(target.title)}</span>
            <span class="linked-target-meta">${renderStartupChip(target.startup)}<span>${escapeHtml(t(`extra.kinds.${target.section}`))}</span>${target.status ? statusBadgeHtml(target.status) : ""}</span>
          </button>`).join("")}</div>`;
    return `
      <div class="linked-target-section linked-media-section campaign-other-startups">
        <div class="linked-target-section-title">${escapeHtml(t("extra.campaigns.otherStartups", { count: entry.targets.length }))}</div>
        ${body}
      </div>`;
  }

  // Which startups use a tag, with how many records each.
  function renderTagStartupUsage(tagId) {
    const usage = tagUsageOf(tagId);
    if (!usage.startups.length) return "";
    return `<div class="tag-startup-usage"><div class="block-title">${escapeHtml(t("extra.tags.inStartups"))}</div><ul>${usage.startups.map((startup) => `<li>${escapeHtml(startup.name)}: ${escapeHtml(String(startup.count))}</li>`).join("")}</ul></div>`;
  }

  function renderTags() {
    if (!elements.tagList) return;
    setExtraCount("tags", tagDefinitions.length);
    if (!tagUsageCache) loadTagUsage();

    if (elements.tagSearchInput && elements.tagSearchInput.value !== state.tagSearch) {
      elements.tagSearchInput.value = state.tagSearch || "";
    }
    if (elements.tagUsageFilter && elements.tagUsageFilter.value !== state.tagUsageFilter) {
      elements.tagUsageFilter.value = state.tagUsageFilter || "all";
    }

    const allRecords = getAllTagRecords();
    if (!allRecords.length) {
      elements.tagList.innerHTML = extraEmptyStateHtml(t("extra.tags.emptyTitle"), t("extra.tags.emptyHint"));
      renderManagerPagination(elements.tagPagination, 0, "tagPage");
      return;
    }

    const records = getFilteredTagRecords(allRecords);
    if (!records.length) {
      elements.tagList.innerHTML = extraEmptyStateHtml(t("extra.noMatchTitle"), t("extra.noMatchHint"));
      renderManagerPagination(elements.tagPagination, 0, "tagPage");
      return;
    }

    const paged = getManagerPageItems(records, "tagPage");
    elements.tagList.innerHTML = paged.map(renderTagCard).join("");
    renderManagerPagination(elements.tagPagination, records.length, "tagPage");
  }

  function renderTagCard(record) {
    const isEditing = state.editingTagId === record.id;
    const targetCount = record.targets.length;
    const programCount = record.programs.length;
    const fundingCount = record.funding.length;
    const mediaCount = record.media.length;
    const campaignCount = record.campaigns.length;
    const feedbackCount = record.feedback.length;
    const description = record.description || "";

    if (isEditing) {
      return `
        <article class="manager-card tag-card editing-card" data-tag-id="${escapeAttribute(record.id)}">
          <div class="manager-card-header">
            <div>
              <strong style="color: var(--accent);">${tHtml("app.renderTags.editingTag", { tag: escapeHtml(record.label || record.id) })}</strong>
              <span>${escapeHtml(t("app.renderTagCard.changesAreSavedAutomatically"))}</span>
            </div>
            <div class="card-actions">
              <button class="icon-button success-btn" type="button" data-tooltip="${escapeAttribute(t("app.renderTagCard.doneEditing"))}" aria-label="${escapeAttribute(t("app.renderTagCard.doneEditing"))}" data-tag-action="done" data-id="${escapeAttribute(record.id)}">
                <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
              </button>
            </div>
          </div>
          <div class="manager-card-grid">
            <div class="tag-rename-row">
              <label>
                ${escapeHtml(t("extra.tags.name"))}
                <input class="inline-input" type="text" value="${escapeAttribute(record.id)}" maxlength="60" data-tag-rename-input="${escapeAttribute(record.id)}">
              </label>
              <button class="secondary-button compact" type="button" data-tag-action="rename" data-id="${escapeAttribute(record.id)}">${escapeHtml(t("extra.tags.rename"))}</button>
            </div>
            <label>
              ${escapeHtml(t("extra.tags.colour"))}
              <input type="color" value="${escapeAttribute(record.definition?.color || "#6b7280")}" data-tag-field="color" data-id="${escapeAttribute(record.id)}">
            </label>
            <div class="tag-merge-row">
              <label>
                ${escapeHtml(t("extra.tags.mergeInto"))}
                <select class="row-select" data-tag-merge-target="${escapeAttribute(record.id)}">
                  ${getAllTagRecords().filter((other) => other.id !== record.id).map((other) => `<option value="${escapeAttribute(other.id)}">#${escapeHtml(other.label || other.id)}</option>`).join("")}
                </select>
              </label>
              <button class="secondary-button compact" type="button" data-tag-action="merge" data-id="${escapeAttribute(record.id)}">${escapeHtml(t("extra.tags.merge"))}</button>
            </div>
            <label class="wide-field">
              ${escapeHtml(t("app.renderTagCard.description"))}
              <textarea class="auto-expand-field" data-tag-field="description" data-id="${escapeAttribute(record.id)}" rows="2">${escapeHtml(description)}</textarea>
            </label>
            <p class="settings-hint wide-field">${escapeHtml(t("extra.tags.everywhereHint"))}</p>
          </div>
          ${renderTagStartupUsage(record.id)}
          ${renderTagUsageSections(record)}
        </article>
      `;
    }

    return `
      <article class="manager-card tag-card read-only-card" data-tag-id="${escapeAttribute(record.id)}">
        <div class="manager-card-header">
          <div>
            <strong>${record.definition?.color ? `<span class="tag-colour" style="background:${escapeAttribute(record.definition.color)}" aria-hidden="true"></span>` : ""}#${escapeHtml(record.label || record.id)}</strong>
            <div class="card-meta">
              <span class="meta-item"><svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle></svg> ${escapeHtml(t("app.counts.target", { count: targetCount }))}</span>
              <span class="meta-item">${escapeHtml(t("app.counts.program", { count: programCount }))}</span>
              <span class="meta-item">${escapeHtml(t("app.counts.fundingRecord", { count: fundingCount }))}</span>
              <span class="meta-item"><svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><path d="M21 15l-5-5L5 21"></path></svg> ${escapeHtml(t("app.counts.media", { count: mediaCount }))}</span>
              <span class="meta-item"><svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l19-9-9 19-2-8-8-2z"></path></svg> ${escapeHtml(t("app.counts.campaign", { count: campaignCount }))}</span>
              <span class="meta-item"><svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg> ${escapeHtml(t("app.counts.feedback", { count: feedbackCount }))}</span>
              ${description ? `<span class="meta-item">${escapeHtml(t("app.renderTagCard.described"))}</span>` : `<span class="meta-item">${escapeHtml(t("app.renderTagCard.noDescription"))}</span>`}
              ${tagUsageCache && !tagUsageCache.loading ? `<span class="meta-item">${escapeHtml(t("extra.tags.usedAcross", { count: tagUsageOf(record.id).total, startups: tagUsageOf(record.id).startups.length }))}</span>` : ""}
            </div>
          </div>
          <div class="card-actions">
            ${targetCount ? `
            <button class="icon-button" type="button" data-tooltip="${escapeAttribute(t("app.renderTagCard.filterPipelineByTag"))}" aria-label="${escapeAttribute(t("app.renderTagCard.filterPipelineByTag"))}" data-tag-action="filter" data-id="${escapeAttribute(record.id)}">
              <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>
            </button>` : ""}
            <button class="icon-button" type="button" data-tooltip="${escapeAttribute(t("app.renderTagCard.editTag"))}" aria-label="${escapeAttribute(t("app.renderTagCard.editTag"))}" data-tag-action="edit" data-id="${escapeAttribute(record.id)}">
              <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            </button>
            <button class="icon-button" type="button" data-tooltip="${escapeAttribute(t("recycle.deleteTag"))}" aria-label="${escapeAttribute(t("recycle.deleteTag"))}" data-tag-action="delete" data-id="${escapeAttribute(record.id)}">
              <svg aria-hidden="true" width="15" height="15"><use href="#icon-trash"></use></svg>
            </button>
          </div>
        </div>
        ${description ? `
        <div class="campaign-details-grid tag-details-grid">
          <div class="detail-block wide-block">
            <div class="block-title">${escapeHtml(t("app.renderTagCard.description"))}</div>
            <div class="block-content markdown-rendered">${renderMarkdown(description)}</div>
          </div>
        </div>` : ""}
        ${renderTagUsageSections(record)}
      </article>
    `;
  }

  function renderTagUsageSections(record) {
    const renderManagerRecords = (records, owner, emptyText) => {
      if (!records.length) return `<div class="linked-target-empty">${escapeHtml(emptyText)}</div>`;
      return `<div class="linked-target-list">${records
        .slice()
        .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
        .map((item) => {
          const title = owner === "program" ? item.name : item.funder;
          const subtitle = owner === "program" ? item.applicationName : item.opportunity;
          return `<button class="linked-target-item linked-target-main" type="button" data-manager-open="${owner}" data-id="${escapeAttribute(item.id)}">
            <span class="linked-target-name">${escapeHtml(title)}</span>
            <span class="linked-target-meta">${statusBadgeHtml(item.status)}${subtitle ? `<span>${escapeHtml(subtitle)}</span>` : ""}</span>
          </button>`;
        }).join("")}</div>`;
    };
    const campaignItems = record.campaigns
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(
        (campaign) => `
          <div class="linked-target-item">
            <span class="linked-target-name">${escapeHtml(campaign.name)}</span>
            <span class="linked-target-meta">
              <span class="status-badge" data-status="${escapeAttribute(campaign.status)}">${escapeHtml(Statuses.campaignStatusLabel(campaign.status))}</span>
            </span>
          </div>`,
      )
      .join("");
    const feedbackItems = record.feedback
      .slice()
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")) || a.title.localeCompare(b.title))
      .map(
        (item) => `
          <div class="linked-target-item">
            <span class="linked-target-name">${escapeHtml(item.title)}</span>
            <span class="linked-target-meta">
              <span class="type-badge" data-type="${escapeAttribute(item.type)}">${escapeHtml(item.type.toUpperCase())}</span>
              <span class="status-badge" data-status="${escapeAttribute(item.status)}">${escapeHtml(item.status.toUpperCase())}</span>
            </span>
          </div>`,
      )
      .join("");
    return `
      <div class="tag-usage-grid">
        ${renderCollapsibleTargetSection({
          id: `tag-targets:${record.id}`,
          title: t("ui.common.targets"),
          targets: record.targets,
          emptyText: t("app.renderTagUsageSections.noTargetsUseThisTag"),
        })}
        <div class="linked-target-section linked-media-section">
          <div class="linked-target-section-title">${escapeHtml(t("app.renderTagUsageSections.programs"))}</div>
          ${renderManagerRecords(record.programs, "program", t("app.renderTagUsageSections.noProgramsUseThisTag"))}
        </div>
        <div class="linked-target-section linked-media-section">
          <div class="linked-target-section-title">${escapeHtml(t("ui.common.funding"))}</div>
          ${renderManagerRecords(record.funding, "funding", t("app.renderTagUsageSections.noFundingRecordsUseThis"))}
        </div>
        <div class="linked-target-section linked-media-section">
          <div class="linked-target-section-title">${escapeHtml(t("app.renderTagUsageSections.media"))}</div>
          ${renderLinkedMediaList(record.media, t("app.renderTagUsageSections.noMediaUsesThisTag"))}
        </div>
        <div class="linked-target-section linked-media-section">
          <div class="linked-target-section-title">${escapeHtml(t("ui.common.campaigns"))}</div>
          ${campaignItems ? `<div class="linked-target-list">${campaignItems}</div>` : `<div class="linked-target-empty">${escapeHtml(t("app.renderTagUsageSections.noCampaignsUseThisTag"))}</div>`}
        </div>
        <div class="linked-target-section linked-media-section">
          <div class="linked-target-section-title">${escapeHtml(t("app.renderTagUsageSections.feedback"))}</div>
          ${feedbackItems ? `<div class="linked-target-list">${feedbackItems}</div>` : `<div class="linked-target-empty">${escapeHtml(t("app.renderTagUsageSections.noFeedbackUsesThisTag"))}</div>`}
        </div>
      </div>
    `;
  }

  function renderCollapsibleTargetSection({ id, title, targets, emptyText }) {
    const expanded = isLinkedTargetSectionExpanded(id);
    const targetCount = targets.length;
    return `
      <div class="linked-target-section ${expanded ? "expanded" : "collapsed"}">
        <button
          class="linked-target-toggle"
          type="button"
          data-linked-target-toggle="${escapeAttribute(id)}"
          aria-expanded="${expanded}"
        >
          <span class="linked-target-section-title">${escapeHtml(title)}</span>
          <span class="linked-target-count">${targetCount}</span>
          <span class="linked-target-toggle-action">${expanded ? t("app.renderCollapsibleTargetSection.hide") : t("app.renderCollapsibleTargetSection.show")}</span>
          <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </button>
        ${expanded ? renderLinkedTargetList(targets, emptyText) : ""}
      </div>
    `;
  }

  function renderLinkedTargetList(targets, emptyText) {
    if (!targets.length) {
      return `<div class="linked-target-empty">${escapeHtml(emptyText)}</div>`;
    }

    return `
      <div class="linked-target-list">
        ${targets.slice().sort(compareItems).map(renderLinkedTargetItem).join("")}
      </div>
    `;
  }

  function isLinkedTargetSectionExpanded(id) {
    return (state.expandedLinkedTargetSections || []).includes(id);
  }

  function toggleLinkedTargetSection(id) {
    if (!id) return;
    const expanded = new Set(state.expandedLinkedTargetSections || []);
    if (expanded.has(id)) {
      expanded.delete(id);
    } else {
      expanded.add(id);
    }
    state.expandedLinkedTargetSections = Array.from(expanded);
    render();
  }

  function togglePanel(panel) {
    let collapsedKey, bodyId, toggleId;
    if (panel === "focus") {
      collapsedKey = "focusPanelCollapsed";
      bodyId = "focusPanelBody";
      toggleId = "focusPanelToggle";
    } else if (panel === "form") {
      collapsedKey = "formPanelCollapsed";
      bodyId = "formPanelBody";
      toggleId = "formPanelToggle";
    } else if (panel === "table") {
      collapsedKey = "tablePanelCollapsed";
      bodyId = "tablePanelBody";
      toggleId = "tablePanelToggle";
    } else if (panel === "program-focus") {
      collapsedKey = "programFocusPanelCollapsed";
      bodyId = "programFocusPanelBody";
      toggleId = "programFocusPanelToggle";
    } else if (panel === "program-form") {
      collapsedKey = "programFormPanelCollapsed";
      bodyId = "programFormPanelBody";
      toggleId = "programFormPanelToggle";
    } else if (panel === "program-table") {
      collapsedKey = "programTablePanelCollapsed";
      bodyId = "programTablePanelBody";
      toggleId = "programTablePanelToggle";
    } else if (panel === "funding-focus") {
      collapsedKey = "fundingFocusPanelCollapsed";
      bodyId = "fundingFocusPanelBody";
      toggleId = "fundingFocusPanelToggle";
    } else if (panel === "funding-form") {
      collapsedKey = "fundingFormPanelCollapsed";
      bodyId = "fundingFormPanelBody";
      toggleId = "fundingFormPanelToggle";
    } else if (panel === "funding-rounds") {
      collapsedKey = "fundingRoundsPanelCollapsed";
      bodyId = "fundingRoundsPanelBody";
      toggleId = "fundingRoundsPanelToggle";
    } else if (panel === "funding-table") {
      collapsedKey = "fundingTablePanelCollapsed";
      bodyId = "fundingTablePanelBody";
      toggleId = "fundingTablePanelToggle";
    } else {
      return;
    }

    state[collapsedKey] = !state[collapsedKey];

    const body = document.getElementById(bodyId);
    const toggle = document.getElementById(toggleId);
    if (body) {
      body.classList.toggle("collapsed", state[collapsedKey]);
      body.style.display = state[collapsedKey] ? "none" : "";
    }
    if (toggle) {
      toggle.classList.toggle("collapsed", state[collapsedKey]);
    }
  }

  function applyPanelCollapseState() {
    [
      "focus",
      "form",
      "table",
      "program-focus",
      "program-form",
      "program-table",
      "funding-focus",
      "funding-form",
      "funding-rounds",
      "funding-table"
    ].forEach((panel) => {
      let collapsedKey, bodyId, toggleId;
      if (panel === "focus") {
        collapsedKey = "focusPanelCollapsed";
        bodyId = "focusPanelBody";
        toggleId = "focusPanelToggle";
      } else if (panel === "form") {
        collapsedKey = "formPanelCollapsed";
        bodyId = "formPanelBody";
        toggleId = "formPanelToggle";
      } else if (panel === "table") {
        collapsedKey = "tablePanelCollapsed";
        bodyId = "tablePanelBody";
        toggleId = "tablePanelToggle";
      } else if (panel === "program-focus") {
        collapsedKey = "programFocusPanelCollapsed";
        bodyId = "programFocusPanelBody";
        toggleId = "programFocusPanelToggle";
      } else if (panel === "program-form") {
        collapsedKey = "programFormPanelCollapsed";
        bodyId = "programFormPanelBody";
        toggleId = "programFormPanelToggle";
      } else if (panel === "program-table") {
        collapsedKey = "programTablePanelCollapsed";
        bodyId = "programTablePanelBody";
        toggleId = "programTablePanelToggle";
      } else if (panel === "funding-focus") {
        collapsedKey = "fundingFocusPanelCollapsed";
        bodyId = "fundingFocusPanelBody";
        toggleId = "fundingFocusPanelToggle";
      } else if (panel === "funding-form") {
        collapsedKey = "fundingFormPanelCollapsed";
        bodyId = "fundingFormPanelBody";
        toggleId = "fundingFormPanelToggle";
      } else if (panel === "funding-rounds") {
        collapsedKey = "fundingRoundsPanelCollapsed";
        bodyId = "fundingRoundsPanelBody";
        toggleId = "fundingRoundsPanelToggle";
      } else if (panel === "funding-table") {
        collapsedKey = "fundingTablePanelCollapsed";
        bodyId = "fundingTablePanelBody";
        toggleId = "fundingTablePanelToggle";
      } else {
        return;
      }

      const body = document.getElementById(bodyId);
      const toggle = document.getElementById(toggleId);
      if (body) {
        body.classList.toggle("collapsed", state[collapsedKey]);
        body.style.display = state[collapsedKey] ? "none" : "";
      }
      if (toggle) {
        toggle.classList.toggle("collapsed", state[collapsedKey]);
      }
    });
  }

  function renderLinkedTargetItem(item) {
    const safeHref = safeLink(item.link);
    const category = getCategory(item.category);
    const subcategoriesDisplay = getSubcategoriesDisplay(item);
    const campaignName = getCampaignName(item.campaignId);
    const dateText = formatDateTime(item.date, item.time);
    const tags = (item.tags || []).slice(0, 4);

    return `
      <div class="linked-target-item ${safeHref ? "has-link" : ""}">
        <button class="linked-target-main" type="button" data-target-action="edit-details" data-id="${escapeAttribute(item.id)}">
          <span class="linked-target-name">${escapeHtml(item.platform)}</span>
          <span class="linked-target-meta">
            <span class="status-pill" data-status="${escapeAttribute(item.status)}" data-status-group="${escapeAttribute(Statuses.groupOf(item.status).replace(/_/g, "-"))}" title="${escapeAttribute(Statuses.description(item.status))}">${escapeHtml(getStatusLabel(item.status))}</span>
            <span class="priority-pill" data-priority="${escapeAttribute(item.priority)}">${escapeHtml(item.priority)}</span>
            <span>${escapeHtml(category.shortName)}${subcategoriesDisplay ? ` / ${escapeHtml(subcategoriesDisplay)}` : ""}</span>
            ${campaignName ? `<span>${escapeHtml(campaignName)}</span>` : ""}
            <span>${escapeHtml(dateText)}</span>
          </span>
          ${tags.length ? `<span class="linked-target-tags">${tags.map((tag) => `<span class="tag-pill tag-pill-readonly"${tagTooltipAttrs(tag)}>${escapeHtml(tag)}</span>`).join("")}</span>` : ""}
        </button>
        ${safeHref ? `
        <a class="linked-target-open" href="${escapeAttribute(safeHref)}" target="_blank" rel="noreferrer" data-tooltip="${escapeAttribute(t("app.renderLinkedTargetItem.openTargetLink"))}" aria-label="${escapeAttribute(t("app.renderLinkedTargetItem.openTargetLink"))}">
          <svg><use href="#icon-link"></use></svg>
        </a>` : ""}
      </div>
    `;
  }

  function renderLinkedMediaList(mediaItems, emptyText) {
    if (!mediaItems.length) {
      return `<div class="linked-target-empty">${escapeHtml(emptyText)}</div>`;
    }

    return `
      <div class="linked-target-list">
        ${mediaItems
          .slice()
          .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")) || a.title.localeCompare(b.title))
          .map(renderLinkedMediaItem)
          .join("")}
      </div>
    `;
  }

  function renderLinkedMediaItem(media) {
    const href = mediaOpenHref(media);
    return `
      <div class="linked-target-item linked-media-item ${href ? "has-link" : ""}">
        <button class="linked-target-main" type="button" data-linked-media-action="edit" data-id="${escapeAttribute(media.id)}">
          <span class="linked-target-name">${escapeHtml(media.title)}</span>
          <span class="linked-target-meta">
            <span class="type-badge" data-type="${escapeAttribute(media.type)}">${escapeHtml(getMediaTypeLabel(media.type))}</span>
            <span class="source-badge" data-source="${escapeAttribute(media.sourceType)}">${escapeHtml(getMediaSourceLabel(media.sourceType))}</span>
            <span>${tHtml("app.renderLinkedMediaItem.updated", { updatedAt: escapeHtml(formatShortTimestamp(media.updatedAt)) })}</span>
          </span>
        </button>
        ${href ? `
        <a class="linked-target-open" href="${escapeAttribute(href)}" target="_blank" rel="noreferrer" data-tooltip="${escapeAttribute(t("app.renderLinkedMediaItem.openMedia"))}" aria-label="${escapeAttribute(t("app.renderLinkedMediaItem.openMedia"))}">
          <svg><use href="#icon-link"></use></svg>
        </a>` : ""}
      </div>
    `;
  }

  function getAiKindLabel(kind) {
    return kind === "subscription" ? t("app.getAiKindLabel.subscription") : t("app.getAiKindLabel.apiAccess");
  }

  function renderAiLinks(links) {
    if (!links.length) return `<span class="ai-empty-value">&mdash;</span>`;
    return `<div class="ai-links">${links
      .map((link) => {
        const href = safeLink(link.url);
        return href
          ? `<a class="ai-link" href="${escapeAttribute(href)}" target="_blank" rel="noreferrer" title="${escapeAttribute(href)}">${escapeHtml(link.label)}</a>`
          : `<span class="ai-link">${escapeHtml(link.label)}</span>`;
      })
      .join("")}</div>`;
  }

  // Monthly totals in lei and dollars. A cost that names RON or lei is in
  // lei; any other number is read as dollars and converted at the rate set on
  // the page.
  function calculateSubscriptionTotals(accounts) {
    const usdToRon = state.aiSettings.usdToRon;
    let totalRon = 0;
    let totalUsd = 0;

    accounts.forEach((account) => {
      if (!account || !account.cost || account.strikethrough) return;
      const costStr = String(account.cost).trim();
      const match = costStr.match(/([\d.]+)/);
      if (!match) return;
      const num = parseFloat(match[1]);
      if (isNaN(num)) return;

      if (/ron|lei/i.test(costStr)) {
        totalRon += num;
        totalUsd += num / usdToRon;
      } else {
        totalUsd += num;
        totalRon += num * usdToRon;
      }
    });

    return { totalRon, totalUsd };
  }

  function renderAiGroups() {
    renderAiFlow();
    renderAiRate();
    if (!elements.aiGroups) return;
    const query = String(state.aiSearch || "").toLowerCase();
    const matches = (account) => !query || [account.name, account.models, account.details, account.cost].join(" ").toLowerCase().includes(query);
    const groups = [
      { kind: "subscription", title: t("app.renderAiGroups.subscriptions") },
      { kind: "api", title: t("app.renderAiGroups.apiAccess") },
    ].map((group) => ({
      ...group,
      accounts: state.aiAccounts.filter((account) => account.kind === group.kind && matches(account)),
    }));
    const total = state.aiAccounts.length;
    setExtraCount("ai", total);

    if (!total) {
      elements.aiGroups.innerHTML = extraEmptyStateHtml(t("extra.ai.emptyTitle"), t("extra.ai.emptyHint"));
      return;
    }
    if (!groups.some((group) => group.accounts.length)) {
      elements.aiGroups.innerHTML = extraEmptyStateHtml(t("extra.noMatchTitle"), t("extra.noMatchHint"));
      return;
    }

    elements.aiGroups.innerHTML = groups
      .filter((group) => group.accounts.length)
      .map((group) => {
        const isSub = group.kind === "subscription";
        const totals = isSub ? calculateSubscriptionTotals(group.accounts) : null;
        const totalFooter = isSub && totals ? `
          <div class="ai-slim-separator" aria-hidden="true"></div>
          <div class="ai-total-row">
            <span class="ai-total-label">${escapeHtml(t("app.renderAiGroups.totalMonthlyCost"))}</span>
            <span class="ai-total-value"><strong>${tHtml("app.renderAiGroups.ron", { value: totals.totalRon.toFixed(2) })}</strong> <span class="ai-total-usd">($${totals.totalUsd.toFixed(2)})</span></span>
          </div>
        ` : "";

        return `
          <section class="ai-group">
            <div class="ai-group-heading">
              <h3>${escapeHtml(group.title)}</h3>
              <span>${escapeHtml(t("app.counts.entry", { count: group.accounts.length }))}</span>
            </div>
            <div class="ai-table">
              <div class="ai-column-head" aria-hidden="true">
                <span>${escapeHtml(t("app.renderAiGroups.provider"))}</span>
                <span>${escapeHtml(t("app.renderAiGroups.modelsToPrefer"))}</span>
                <span>${escapeHtml(t("app.renderAiGroups.details"))}</span>
                <span>${escapeHtml(t("ui.common.links"))}</span>
                <span></span>
              </div>
              ${group.accounts.map(renderAiAccountCard).join("")}
              ${totalFooter}
            </div>
          </section>
        `;
      })
      .join("");
  }

  // The dollar to leu rate the totals use, editable, with the day it was last
  // changed.
  function renderAiRate() {
    if (!elements.aiRate) return;
    const { usdToRon, rateUpdatedAt } = state.aiSettings;
    const input = elements.aiRate.querySelector("input");
    if (input && document.activeElement === input) return;
    elements.aiRate.innerHTML = `
      <label class="ai-rate-field">
        <span class="label-title">${escapeHtml(t("extra.ai.rateLabel"))}</span>
        <span class="ai-rate-input"><span aria-hidden="true">${escapeHtml(t("app.renderAiRate.1Usd"))}</span><input type="number" min="0.0001" step="0.0001" value="${escapeAttribute(String(usdToRon))}" data-ai-rate aria-describedby="aiRateHint"><span aria-hidden="true">${escapeHtml(t("app.renderAiRate.ron"))}</span></span>
      </label>
      <span class="settings-hint" id="aiRateHint">${escapeHtml(rateUpdatedAt ? t("extra.ai.rateUpdated", { date: formatTimestamp(rateUpdatedAt) }) : t("extra.ai.rateDefault", { rate: String(DEFAULT_USD_TO_RON) }))}</span>`;
  }

  function updateAiRate(value) {
    const rate = Number(value);
    if (!Number.isFinite(rate) || rate <= 0 || rate === state.aiSettings.usdToRon) return;
    state.aiSettings = { usdToRon: rate, rateUpdatedAt: new Date().toISOString() };
    persist(t("extra.ai.rateSaved"));
    renderAiGroups();
  }

  // "Add subscription or API": a new entry, open for editing. Its type can be
  // changed in the form.
  function addAiAccount() {
    const account = normalizeAiAccount({ id: makeId(), kind: "subscription", name: t("extra.ai.newEntry") });
    state.aiAccounts.unshift(account);
    state.editingAiAccountId = account.id;
    persist(t("extra.ai.added"));
    renderAiGroups();
    window.setTimeout(() => elements.aiGroups?.querySelector(`[data-ai-id="${CSS.escape(account.id)}"] [data-ai-field="name"]`)?.select(), 0);
  }

  function renderAiAccountCard(account) {
    const isEditing = state.editingAiAccountId === account.id;
    const separatorHtml = account.hasSeparatorAbove ? `<div class="ai-slim-separator" aria-hidden="true"></div>` : "";
    if (isEditing) {
      return `
        ${separatorHtml}
        <article class="manager-card compact-card ai-card editing-card${account.hasSeparatorAbove ? " has-slim-separator" : ""}" data-ai-id="${escapeAttribute(account.id)}">
          <div class="manager-card-header">
            <div>
              <strong style="color: var(--accent);">${tHtml("app.renderAiAccountCard.editing", { name: escapeHtml(account.name) })}</strong>
              <span>${escapeHtml(t("app.renderAiAccountCard.changesAreSavedAutomatically"))}</span>
            </div>
            <div class="card-actions">
              <button class="icon-button success-btn" type="button" data-tooltip="${escapeAttribute(t("app.renderAiAccountCard.doneEditing"))}" aria-label="${escapeAttribute(t("app.renderAiAccountCard.doneEditing"))}" data-ai-action="done" data-id="${escapeAttribute(account.id)}">
                <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
              </button>
            </div>
          </div>
          <div class="manager-card-grid compact-grid">
            <label>
              ${escapeHtml(t("app.renderAiAccountCard.type"))}
              <select class="row-select" data-ai-field="kind" data-id="${escapeAttribute(account.id)}">
                <option value="subscription" ${account.kind === "subscription" ? "selected" : ""}>${escapeHtml(t("app.renderAiAccountCard.subscription"))}</option>
                <option value="api" ${account.kind === "api" ? "selected" : ""}>${escapeHtml(t("app.renderAiAccountCard.apiAccess"))}</option>
              </select>
            </label>
            <label>
              ${escapeHtml(t("ui.common.name"))}
              <input class="inline-input" type="text" value="${escapeAttribute(account.name)}" data-ai-field="name" data-id="${escapeAttribute(account.id)}">
            </label>
            <label>
              ${escapeHtml(t("app.renderAiAccountCard.cost"))}
              <input class="inline-input" type="text" value="${escapeAttribute(account.cost)}" data-ai-field="cost" data-id="${escapeAttribute(account.id)}" placeholder="${escapeAttribute(t("app.renderAiAccountCard.leaveBlankIfUnknown"))}">
            </label>
            <label class="checkbox-field">
              <input type="checkbox" data-ai-field="strikethrough" data-id="${escapeAttribute(account.id)}" ${account.strikethrough ? "checked" : ""}>
              <span>${escapeHtml(t("app.renderAiAccountCard.strikethroughExcludeFromMonthlyTotal"))}</span>
            </label>
            <label class="wide-field">
              ${escapeHtml(t("app.renderAiAccountCard.modelsToPrefer"))}
              <textarea class="auto-expand-field" data-ai-field="models" data-id="${escapeAttribute(account.id)}" rows="2">${escapeHtml(account.models)}</textarea>
            </label>
            <label class="wide-field">
              ${escapeHtml(t("app.renderAiAccountCard.details"))}
              <textarea class="auto-expand-field" data-ai-field="details" data-id="${escapeAttribute(account.id)}" rows="2">${escapeHtml(account.details)}</textarea>
            </label>
            <label class="wide-field">
              ${escapeHtml(t("ui.common.links"))}
              <textarea class="auto-expand-field" data-ai-field="links" data-id="${escapeAttribute(account.id)}" rows="2" placeholder="${escapeAttribute(t("app.renderAiAccountCard.labelUrl"))}">${escapeHtml(account.links.map((link) => `${link.label} | ${link.url}`).join("\n"))}</textarea>
            </label>
          </div>
        </article>
      `;
    }

    return `
      ${separatorHtml}
      <article class="manager-card compact-card ai-card read-only-card ai-compact-card${account.hasSeparatorAbove ? " has-slim-separator" : ""}${account.strikethrough ? " is-strikethrough" : ""}" data-ai-id="${escapeAttribute(account.id)}">
        <div class="manager-card-header">
          <div>
            <div class="ai-title-row">
              <strong>${escapeHtml(account.name)}</strong>
              ${account.cost ? `<span class="ai-cost">${escapeHtml(account.cost)}</span>` : ""}
            </div>
            <div class="card-meta">
              <span class="ai-kind-badge" data-kind="${escapeAttribute(account.kind)}">${escapeHtml(getAiKindLabel(account.kind))}</span>
            </div>
          </div>
          <div class="card-actions">
            <button class="icon-button" type="button" data-tooltip="${escapeAttribute(t("app.renderAiAccountCard.editAiEntry"))}" aria-label="${escapeAttribute(t("app.renderAiAccountCard.editAiEntry"))}" data-ai-action="edit" data-id="${escapeAttribute(account.id)}">
              <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            </button>
            <button class="icon-button danger-hover" type="button" data-tooltip="${escapeAttribute(t("app.renderAiAccountCard.deleteAiEntry"))}" aria-label="${escapeAttribute(t("app.renderAiAccountCard.deleteAiEntry"))}" data-ai-action="delete" data-id="${escapeAttribute(account.id)}">
              <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
            </button>
          </div>
        </div>
        <div class="ai-card-grid">
          <div class="ai-detail-block">
            <div class="ai-detail-label">${escapeHtml(t("app.renderAiAccountCard.modelsToPrefer"))}</div>
            <div class="ai-detail-value">${escapeHtml(account.models || t("app.renderAiAccountCard.notSpecified"))}</div>
          </div>
          <div class="ai-detail-block">
            <div class="ai-detail-label">${escapeHtml(t("app.renderAiAccountCard.details"))}</div>
            <div class="ai-detail-value">${escapeHtml(account.details || t("app.renderAiAccountCard.noDetailsSaved"))}</div>
          </div>
          <div class="ai-detail-block ai-links-block">
            <div class="ai-detail-label">${escapeHtml(t("ui.common.links"))}</div>
            ${renderAiLinks(account.links)}
          </div>
        </div>
      </article>
    `;
  }

  function renderAiFlow() {
    if (!elements.aiFlowWrap) return;
    ensureAiFlowSeparator();
    const items = state.aiFlow || [];
    const flowCount = items.filter((item) => !item.isSeparator).length;
    const total = items.length;

    const rowsHtml = total === 0
      ? `<div class="empty-state compact" style="padding: 14px; text-align: center;"><p style="margin: 0; color: var(--muted); font-size: 0.82rem;">${escapeHtml(t("app.renderAiFlow.noFlowEntriesYetClick"))}</p></div>`
      : items.map((item, index) => renderAiFlowRow(item, index, total)).join("");

    const editAllLabel = state.isEditingAllAiFlow ? t("app.renderAiFlow.doneEditing") : t("app.renderAiFlow.editAll");

    elements.aiFlowWrap.innerHTML = `
      <section class="ai-group ai-flow-group">
        <div class="ai-group-heading ai-flow-heading">
          <div class="ai-flow-heading-title">
            <h3>${escapeHtml(t("app.renderAiFlow.currentFlow"))}</h3>
            <span class="ai-flow-count">${escapeHtml(t("app.counts.entry", { count: flowCount }))}</span>
          </div>
          <div class="ai-flow-heading-actions">
            ${flowCount > 0 ? `<button class="secondary-button text-btn" type="button" data-ai-flow-action="toggle-edit-all">${escapeHtml(editAllLabel)}</button>` : ""}
            <button class="secondary-button text-btn" type="button" data-ai-flow-action="add">
              <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
              ${escapeHtml(t("app.renderAiFlow.addItem"))}
            </button>
          </div>
        </div>
        <div class="ai-table ai-flow-table">
          <div class="ai-flow-column-head" aria-hidden="true">
            <span>${escapeHtml(t("app.renderAiFlow.subApi"))}</span>
            <span>${escapeHtml(t("app.renderAiFlow.model"))}</span>
            <span>${escapeHtml(t("app.renderAiFlow.details"))}</span>
            <span></span>
          </div>
          <div class="ai-flow-list">
            ${rowsHtml}
          </div>
        </div>
      </section>
    `;
  }

  function renderAiFlowSeparatorRow(item, index, total) {
    const isFirst = index === 0;
    const isLast = index === total - 1;
    const title = item.title || "occasional";

    return `
      <div class="ai-flow-separator-row" data-ai-flow-id="${escapeAttribute(item.id)}" draggable="true">
        <div class="ai-flow-separator-line"></div>
        <div class="ai-flow-separator-pill">
          <span class="ai-flow-drag-handle" title="${escapeAttribute(t("app.renderAiFlowSeparatorRow.dragToReorder"))}" aria-label="${escapeAttribute(t("app.renderAiFlowSeparatorRow.dragToReorder"))}">
            <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none"><circle cx="9" cy="5" r="1"></circle><circle cx="9" cy="12" r="1"></circle><circle cx="9" cy="19" r="1"></circle><circle cx="15" cy="5" r="1"></circle><circle cx="15" cy="12" r="1"></circle><circle cx="15" cy="19" r="1"></circle></svg>
          </span>
          <span class="ai-flow-separator-text">${escapeHtml(title)}</span>
        </div>
        <div class="ai-flow-separator-line"></div>
        <div class="card-actions ai-flow-actions ai-flow-separator-actions">
          <button class="icon-button" type="button" data-tooltip="${escapeAttribute(t("app.renderAiFlowSeparatorRow.moveUp"))}" aria-label="${escapeAttribute(t("app.renderAiFlowSeparatorRow.moveUp"))}" data-ai-flow-action="move-up" data-id="${escapeAttribute(item.id)}"${isFirst ? " disabled" : ""}>
            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>
          </button>
          <button class="icon-button" type="button" data-tooltip="${escapeAttribute(t("app.renderAiFlowSeparatorRow.moveDown"))}" aria-label="${escapeAttribute(t("app.renderAiFlowSeparatorRow.moveDown"))}" data-ai-flow-action="move-down" data-id="${escapeAttribute(item.id)}"${isLast ? " disabled" : ""}>
            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </button>
        </div>
      </div>
    `;
  }

  function renderAiFlowRow(item, index, total) {
    if (item.isSeparator) {
      return renderAiFlowSeparatorRow(item, index, total);
    }
    const isEditing = state.isEditingAllAiFlow || state.editingAiFlowIds.has(item.id);
    const isFirst = index === 0;
    const isLast = index === total - 1;

    const moveButtonsHtml = `
      <button class="icon-button" type="button" data-tooltip="${escapeAttribute(t("app.renderAiFlowRow.moveUp"))}" aria-label="${escapeAttribute(t("app.renderAiFlowRow.moveUp"))}" data-ai-flow-action="move-up" data-id="${escapeAttribute(item.id)}"${isFirst ? " disabled" : ""}>
        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>
      </button>
      <button class="icon-button" type="button" data-tooltip="${escapeAttribute(t("app.renderAiFlowRow.moveDown"))}" aria-label="${escapeAttribute(t("app.renderAiFlowRow.moveDown"))}" data-ai-flow-action="move-down" data-id="${escapeAttribute(item.id)}"${isLast ? " disabled" : ""}>
        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
      </button>
    `;

    if (isEditing) {
      return `
        <div class="ai-flow-compact-card editing-flow-card" data-ai-flow-id="${escapeAttribute(item.id)}" draggable="true">
          <div class="ai-flow-cell">
            <input class="inline-input ai-flow-input" type="text" data-ai-flow-field="subApi" data-id="${escapeAttribute(item.id)}" value="${escapeAttribute(item.subApi)}" placeholder="${escapeAttribute(t("app.renderAiFlowRow.subApi"))}">
          </div>
          <div class="ai-flow-cell">
            <input class="inline-input ai-flow-input" type="text" data-ai-flow-field="model" data-id="${escapeAttribute(item.id)}" value="${escapeAttribute(item.model)}" placeholder="${escapeAttribute(t("app.renderAiFlowRow.model"))}">
          </div>
          <div class="ai-flow-cell">
            <input class="inline-input ai-flow-input" type="text" data-ai-flow-field="details" data-id="${escapeAttribute(item.id)}" value="${escapeAttribute(item.details)}" placeholder="${escapeAttribute(t("app.renderAiFlowRow.details"))}">
          </div>
          <div class="card-actions ai-flow-actions">
            ${moveButtonsHtml}
            ${!state.isEditingAllAiFlow ? `
            <button class="icon-button success-btn" type="button" data-tooltip="${escapeAttribute(t("app.renderAiFlowRow.doneEditing"))}" aria-label="${escapeAttribute(t("app.renderAiFlowRow.doneEditing"))}" data-ai-flow-action="done" data-id="${escapeAttribute(item.id)}">
              <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
            </button>` : ""}
            <button class="icon-button danger-hover" type="button" data-tooltip="${escapeAttribute(t("app.renderAiFlowRow.deleteFlowEntry"))}" aria-label="${escapeAttribute(t("app.renderAiFlowRow.deleteFlowEntry"))}" data-ai-flow-action="delete" data-id="${escapeAttribute(item.id)}">
              <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
            </button>
          </div>
        </div>
      `;
    }

    return `
      <div class="ai-flow-compact-card read-only-flow-card" data-ai-flow-id="${escapeAttribute(item.id)}" draggable="true">
        <div class="ai-flow-cell">
          <strong class="ai-flow-sub-text">${escapeHtml(item.subApi || "—")}</strong>
        </div>
        <div class="ai-flow-cell">
          <span class="ai-flow-text">${escapeHtml(item.model || "—")}</span>
        </div>
        <div class="ai-flow-cell">
          <span class="ai-flow-text">${escapeHtml(item.details || "—")}</span>
        </div>
        <div class="card-actions ai-flow-actions">
          ${moveButtonsHtml}
          <button class="icon-button" type="button" data-tooltip="${escapeAttribute(t("app.renderAiFlowRow.editFlowEntry"))}" aria-label="${escapeAttribute(t("app.renderAiFlowRow.editFlowEntry"))}" data-ai-flow-action="edit" data-id="${escapeAttribute(item.id)}">
            <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
          </button>
          <button class="icon-button danger-hover" type="button" data-tooltip="${escapeAttribute(t("app.renderAiFlowRow.deleteFlowEntry"))}" aria-label="${escapeAttribute(t("app.renderAiFlowRow.deleteFlowEntry"))}" data-ai-flow-action="delete" data-id="${escapeAttribute(item.id)}">
            <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
          </button>
        </div>
      </div>
    `;
  }

  function renderDailyGroups() {
    if (!elements.dailyGroups) return;
    setExtraCount("research", state.dailyLinks.length);

    if (!state.dailyLinks.length) {
      elements.dailyGroups.innerHTML = extraEmptyStateHtml(t("extra.research.emptyTitle"), t("extra.research.emptyHint"));
      return;
    }

    const query = String(state.dailySearch || "").toLowerCase();
    const visible = state.dailyLinks.filter((link) => !query || [link.title, link.url, link.description, Options.label("researchGroups", link.subcategory)].join(" ").toLowerCase().includes(query));
    if (!visible.length) {
      elements.dailyGroups.innerHTML = extraEmptyStateHtml(t("extra.noMatchTitle"), t("extra.noMatchHint"));
      return;
    }
    // The groups in their order, then any group a link names that was removed.
    const groupIds = [...Options.list("researchGroups").map((group) => group.id)];
    visible.forEach((link) => {
      if (!groupIds.includes(link.subcategory)) groupIds.push(link.subcategory);
    });
    const linksByGroup = groupIds.map((groupId) => ({
      groupId,
      label: Options.label("researchGroups", groupId),
      links: visible
        .filter((link) => link.subcategory === groupId)
        .sort((a, b) => dailyPriorityWeight(a.priority) - dailyPriorityWeight(b.priority) || a.title.localeCompare(b.title)),
    }));

    elements.dailyGroups.innerHTML = linksByGroup
      .filter((group) => group.links.length)
      .map((group) => {
        const activeCount = group.links.reduce((count, link) => {
          if (!link.active) return count;
          return count + getDailyLinkUrls(link.url).length;
        }, 0);
        return `
          <section class="manager-group">
            <div class="manager-group-header">
              <div>
                <h3>${researchGroupIcon(group.groupId)} ${escapeHtml(group.label)}</h3>
                <span>${escapeHtml(t("app.counts.activeLink", { count: activeCount }))}</span>
              </div>
              <button class="secondary-button text-btn" type="button" data-daily-open-group="${escapeAttribute(group.groupId)}" ${activeCount ? "" : "disabled"}>${escapeHtml(t("app.renderDailyGroups.openAll"))}</button>
            </div>
            <div class="manager-group-list">
              ${group.links.map(renderDailyLinkCard).join("")}
            </div>
          </section>
        `;
      })
      .join("");
  }

  function renderDailyLinkCard(link) {
    const linkUrls = getDailyLinkUrls(link.url);
    const openLabel = linkUrls.length > 1 ? t("app.renderDailyLinkCard.openAll", { length: linkUrls.length }) : t("app.renderDailyLinkCard.open");
    const isEditing = state.editingDailyLinkId === link.id;

    if (isEditing) {
      return `
        <article class="manager-card compact-card daily-link-card editing-card" data-daily-id="${escapeAttribute(link.id)}">
          <div class="manager-card-header">
            <div>
              <strong style="color: var(--accent);">${tHtml("app.renderDailyLinkCard.editingLink", { title: escapeHtml(link.title) })}</strong>
              <span>${escapeHtml(t("app.renderDailyLinkCard.changesAreSavedAutomatically"))}</span>
            </div>
            <div class="card-actions">
              <button class="icon-button success-btn" type="button" data-tooltip="${escapeAttribute(t("app.renderDailyLinkCard.doneEditing"))}" aria-label="${escapeAttribute(t("app.renderDailyLinkCard.doneEditing"))}" data-daily-action="done" data-id="${escapeAttribute(link.id)}">
                <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
              </button>
            </div>
          </div>
          <div class="manager-card-grid compact-grid">
            <label>
              ${escapeHtml(t("app.renderDailyLinkCard.title"))}
              <input class="inline-input" type="text" value="${escapeAttribute(link.title)}" data-daily-field="title" data-id="${escapeAttribute(link.id)}">
            </label>
            <label>
              ${escapeHtml(t("app.renderDailyLinkCard.group"))}
              <select class="row-select" data-daily-field="subcategory" data-id="${escapeAttribute(link.id)}">
                ${Options.optionsHtml("researchGroups", link.subcategory)}
              </select>
            </label>
            <label>
              ${escapeHtml(t("ui.common.links"))}
              <input class="inline-input" type="text" value="${escapeAttribute(link.url)}" data-daily-field="url" data-id="${escapeAttribute(link.id)}" placeholder="${escapeAttribute(t("app.renderDailyLinkCard.httpsFirstExampleHttpsSecond"))}">
            </label>
            <label>
              ${escapeHtml(t("ui.common.priority"))}
              <select class="row-select" data-daily-field="priority" data-id="${escapeAttribute(link.id)}">
                ${dailyPriorities.map((priority) => `<option ${priority === link.priority ? "selected" : ""}>${escapeHtml(priority)}</option>`).join("")}
              </select>
            </label>
            <label class="checkbox-field">
              <input type="checkbox" data-daily-field="active" data-id="${escapeAttribute(link.id)}" ${link.active ? "checked" : ""}>
              <span>${escapeHtml(t("app.renderDailyLinkCard.active"))}</span>
            </label>
            <label class="checkbox-field">
              <input type="checkbox" data-daily-field="shared" data-id="${escapeAttribute(link.id)}" ${link.shared ? "checked" : ""}>
              <span>${escapeHtml(t("extra.research.shared"))}</span>
            </label>
            <label class="wide-field">
              ${escapeHtml(t("app.renderDailyLinkCard.description"))}
              <textarea class="auto-expand-field" data-daily-field="description" data-id="${escapeAttribute(link.id)}" rows="2">${escapeHtml(link.description)}</textarea>
            </label>
          </div>
        </article>
      `;
    }

    return `
      <article class="manager-card compact-card daily-link-card read-only-card" data-daily-id="${escapeAttribute(link.id)}">
        <div class="manager-card-header">
          <div>
            <div class="daily-title-row">
              <strong>${escapeHtml(link.title)}</strong>
              ${link.active ? `<span class="status-indicator active-dot" title="${escapeAttribute(t("app.renderDailyLinkCard.active"))}"></span>` : `<span class="status-indicator inactive-dot" title="${escapeAttribute(t("app.renderDailyLinkCard.inactive"))}"></span>`}
            </div>
            <div class="card-meta">
              <span class="priority-badge" data-priority="${escapeAttribute(link.priority.toLowerCase())}">${escapeHtml(link.priority)}</span>
              <span class="meta-item">${escapeHtml(Options.label("researchGroups", link.subcategory))}</span>
              ${link.shared ? `<span class="meta-item shared-badge" title="${escapeAttribute(t("extra.research.sharedHint"))}">${escapeHtml(t("extra.research.sharedBadge"))}</span>` : ""}
              ${linkUrls.length > 1 ? `<span class="meta-item">${escapeHtml(t("app.counts.link", { count: linkUrls.length }))}</span>` : ""}
              ${link.lastOpenedAt ? `
              <span class="meta-item">
                <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                ${tHtml("app.renderDailyLinkCard.opened", { lastOpenedAt: escapeHtml(formatTimestamp(link.lastOpenedAt)) })}
              </span>` : ""}
            </div>
          </div>
          <div class="card-actions">
            ${linkUrls.length ? `<button class="secondary-button text-btn action-btn-open" type="button" data-daily-action="open" data-id="${escapeAttribute(link.id)}" aria-label="${escapeAttribute(openLabel)}">
              <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
              ${escapeHtml(openLabel)}
            </button>` : ""}
            <button class="icon-button" type="button" data-tooltip="${escapeAttribute(t("app.renderDailyLinkCard.editLink"))}" aria-label="${escapeAttribute(t("app.renderDailyLinkCard.editLink"))}" data-daily-action="edit" data-id="${escapeAttribute(link.id)}">
              <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            </button>
            <button class="icon-button danger-hover" type="button" data-tooltip="${escapeAttribute(t("app.renderDailyLinkCard.deleteLink"))}" aria-label="${escapeAttribute(t("app.renderDailyLinkCard.deleteLink"))}" data-daily-action="delete" data-id="${escapeAttribute(link.id)}">
              <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
            </button>
          </div>
        </div>
        ${link.description ? `
        <div class="card-description markdown-rendered">
          ${renderMarkdown(link.description)}
        </div>` : ""}
      </article>
    `;
  }

  // Header numbers. "Strong evidence" counts the top half of the evidence
  // list as ordered in Feedback > Options; "Blockers" counts the types whose
  // block is the journey (someone stopped or hesitated) plus bug reports.
  function renderFeedbackSummary() {
    const items = state.feedbackItems;
    const needsReview = items.filter((item) => item.status === "new" || item.status === "reviewing").length;
    const evidence = Options.list("feedbackEvidence").map((option) => option.id);
    const strong = new Set(evidence.slice(Math.floor(evidence.length / 2)));
    const strongEvidence = items.filter((item) => strong.has(item.evidenceLevel)).length;
    const blockers = items.filter((item) => item.type === "bug-report" || ["objection", "onboarding-friction"].includes(item.type)).length;

    if (elements.feedbackTotalCount) elements.feedbackTotalCount.textContent = String(items.length);
    if (elements.feedbackNeedsReviewCount) elements.feedbackNeedsReviewCount.textContent = String(needsReview);
    if (elements.feedbackWorkflowCount) elements.feedbackWorkflowCount.textContent = String(strongEvidence);
    if (elements.feedbackBlockerCount) elements.feedbackBlockerCount.textContent = String(blockers);
  }

  function renderFeedbackList() {
    setExtraCount("feedback", state.feedbackItems.length);
    renderFeedbackSummary();
    renderFeedbackTagFilters();
    renderTagDatalist(tagDatalistId("feedback"));
    if (!elements.feedbackList) return;

    if (!state.feedbackItems.length) {
      elements.feedbackList.innerHTML = extraEmptyStateHtml(t("app.renderFeedbackList.noFeedbackYet"), t("app.renderFeedbackList.recordWhatUsersSayAnd"));
      renderManagerPagination(elements.feedbackPagination, 0, "feedbackPage");
      return;
    }

    const query = String(state.feedbackSearch || "").toLowerCase();
    const filtered = state.feedbackItems.filter((item) => {
      if (query && ![item.title, item.description, item.audience, item.contactName, item.outcome, item.action, (item.tags || []).join(" ")].join(" ").toLowerCase().includes(query)) return false;
      if (state.feedbackTypeFilter !== "all" && item.type !== state.feedbackTypeFilter) return false;
      if (state.feedbackStageFilter !== "all" && item.stage !== state.feedbackStageFilter) return false;
      if (state.feedbackEvidenceFilter !== "all" && item.evidenceLevel !== state.feedbackEvidenceFilter) return false;
      if (state.feedbackTagFilter.length > 0) {
        const itemTags = item.tags || [];
        if (!state.feedbackTagFilter.every((f) => itemTags.includes(f))) {
          return false;
        }
      }
      return true;
    });

    if (!filtered.length) {
      elements.feedbackList.innerHTML = extraEmptyStateHtml(t("extra.noMatchTitle"), t("extra.noMatchHint"));
      renderManagerPagination(elements.feedbackPagination, 0, "feedbackPage");
      return;
    }

    const ordered = filtered
      .slice()
      .sort((a, b) => feedbackStatusWeight(a.status) - feedbackStatusWeight(b.status) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const paged = getManagerPageItems(ordered, "feedbackPage");

    elements.feedbackList.innerHTML = paged
      .map((item) => {
        const href = safeLink(item.link);
        const isEditing = state.editingFeedbackItemId === item.id;
        const typeLabel = Options.label("feedbackTypes", item.type);
        const sourceLabel = Options.label("feedbackSources", item.source);
        const stageLabel = Options.label("feedbackStages", item.stage);
        const areaLabel = Options.label("feedbackAreas", item.area);
        const evidenceLabel = Options.label("feedbackEvidence", item.evidenceLevel);

        if (isEditing) {
          return `
            <article class="manager-card compact-card editing-card feedback-card" data-feedback-id="${escapeAttribute(item.id)}">
              <div class="manager-card-header">
                <div>
                  <strong style="color: var(--accent);">${tHtml("app.renderFeedbackList.editingEvidence", { title: escapeHtml(item.title) })}</strong>
                  <span>${escapeHtml(t("app.renderFeedbackList.changesAreSavedAutomatically"))}</span>
                </div>
                <div class="card-actions">
                  <button class="icon-button success-btn" type="button" data-tooltip="${escapeAttribute(t("app.renderFeedbackList.doneEditing"))}" aria-label="${escapeAttribute(t("app.renderFeedbackList.doneEditing"))}" data-feedback-action="done" data-id="${escapeAttribute(item.id)}">
                    <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                  </button>
                </div>
              </div>
              <div class="manager-card-grid compact-grid">
                <label>
                  ${escapeHtml(t("app.renderFeedbackList.type"))}
                  <select class="row-select" data-feedback-field="type" data-id="${escapeAttribute(item.id)}">
                    ${Options.optionsHtml("feedbackTypes", item.type)}
                  </select>
                </label>
                <label>
                  ${escapeHtml(t("ui.common.status"))}
                  <select class="row-select" data-feedback-field="status" data-id="${escapeAttribute(item.id)}">
                    ${feedbackStatuses.map((status) => `<option value="${status}" ${status === item.status ? "selected" : ""}>${escapeHtml(status)}</option>`).join("")}
                  </select>
                </label>
                <label>
                  ${escapeHtml(t("app.renderFeedbackList.source"))}
                  <select class="row-select" data-feedback-field="source" data-id="${escapeAttribute(item.id)}">
                    ${Options.optionsHtml("feedbackSources", item.source)}
                  </select>
                </label>
                <label>
                  ${escapeHtml(t("app.renderFeedbackList.userOrGroup"))}
                  <input class="inline-input" type="text" value="${escapeAttribute(item.audience)}" data-feedback-field="audience" data-id="${escapeAttribute(item.id)}">
                </label>
                <label>
                  ${escapeHtml(t("app.renderFeedbackList.contactNameHandle"))}
                  <input class="inline-input" type="text" value="${escapeAttribute(item.contactName || "")}" data-feedback-field="contactName" data-id="${escapeAttribute(item.id)}" placeholder="${escapeAttribute(t("app.renderFeedbackList.eGNameEmailOr"))}">
                </label>
                <label>
                  ${escapeHtml(t("app.renderFeedbackList.relationshipDepth"))}
                  <select class="row-select" data-feedback-field="relationshipDepth" data-id="${escapeAttribute(item.id)}">
                    ${Options.optionsHtml("feedbackRelationships", item.relationshipDepth)}
                  </select>
                </label>
                <label>
                  ${escapeHtml(t("ui.common.stage"))}
                  <select class="row-select" data-feedback-field="stage" data-id="${escapeAttribute(item.id)}">
                    ${Options.optionsHtml("feedbackStages", item.stage)}
                  </select>
                </label>
                <label>
                  ${escapeHtml(t("app.renderFeedbackList.productArea"))}
                  <select class="row-select" data-feedback-field="area" data-id="${escapeAttribute(item.id)}">
                    ${Options.optionsHtml("feedbackAreas", item.area)}
                  </select>
                </label>
                <label>
                  ${escapeHtml(t("app.renderFeedbackList.evidenceStrength"))}
                  <select class="row-select" data-feedback-field="evidenceLevel" data-id="${escapeAttribute(item.id)}">
                    ${Options.optionsHtml("feedbackEvidence", item.evidenceLevel)}
                  </select>
                </label>
                <label>
                  ${escapeHtml(t("app.renderFeedbackList.title"))}
                  <input class="inline-input" type="text" value="${escapeAttribute(item.title)}" data-feedback-field="title" data-id="${escapeAttribute(item.id)}">
                </label>
                <label>
                  ${escapeHtml(t("app.renderFeedbackList.sourceLink"))}
                  <input class="inline-input" type="url" value="${escapeAttribute(item.link)}" data-feedback-field="link" data-id="${escapeAttribute(item.id)}">
                </label>
                <div class="picker-field">
                  <span class="label-title">${escapeHtml(t("app.renderFeedbackList.about"))}</span>
                  <div data-feedback-about="${escapeAttribute(item.id)}"></div>
                </div>
                <label class="wide-field">
                  ${escapeHtml(t("app.renderFeedbackList.whatHappened"))}
                  <textarea class="auto-expand-field" data-feedback-field="description" data-id="${escapeAttribute(item.id)}" rows="2">${escapeHtml(item.description)}</textarea>
                </label>
                <label class="wide-field">
                  ${escapeHtml(t("app.renderFeedbackList.outcomeOrMetric"))}
                  <textarea class="auto-expand-field" data-feedback-field="outcome" data-id="${escapeAttribute(item.id)}" rows="2">${escapeHtml(item.outcome)}</textarea>
                </label>
                <label class="wide-field">
                  ${escapeHtml(t("ui.common.nextAction"))}
                  <textarea class="auto-expand-field" data-feedback-field="action" data-id="${escapeAttribute(item.id)}" rows="2">${escapeHtml(item.action)}</textarea>
                </label>
                ${feedbackBlocksFor(item).map((name) => feedbackBlockHtml(name, item, { card: true })).join("")}
                <div class="wide-field inline-tags-field">
                  <span class="label-title">${escapeHtml(t("ui.common.tags"))}</span>
                  <div class="inline-tags-row">
                    <div class="tag-pill-list" data-feedback-tags-list data-id="${escapeAttribute(item.id)}">
                      ${(item.tags || []).map((t) => `<span class="tag-pill"${tagTooltipAttrs(t)}>${escapeHtml(t)}<button type="button" class="tag-remove" data-feedback-tag-remove="${escapeAttribute(t)}" data-id="${escapeAttribute(item.id)}" aria-label="${escapeAttribute(t("app.renderFeedbackList.removeTag"))}">${escapeHtml(t("app.renderFeedbackList.text"))}</button></span>`).join("")}
                    </div>
                    <input class="inline-input inline-tag-input" type="text" data-feedback-tag-input data-id="${escapeAttribute(item.id)}" list="${tagDatalistId("feedback")}" placeholder="${escapeAttribute(t("app.renderFeedbackList.typeATagPressEnter"))}">
                  </div>
                </div>
              </div>
            </article>
          `;
        }

        return `
          <article class="manager-card compact-card read-only-card feedback-card" data-feedback-id="${escapeAttribute(item.id)}">
            <div class="manager-card-header">
              <div>
                <strong>${escapeHtml(item.title)}</strong>
                <div class="card-meta">
                  <span class="type-badge" data-type="${escapeAttribute(item.type)}">${escapeHtml(typeLabel)}</span>
                  <span class="status-badge" data-status="${escapeAttribute(item.status)}">${escapeHtml(item.status.toUpperCase())}</span>
                  ${linkPillsHtml("feedback", item.id, { relations: ["feedback-about"] })}
                  <span class="feedback-detail-pill">${escapeHtml(evidenceLabel)}</span>
                  <span class="meta-item"><svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg> ${tHtml("app.renderFeedbackList.updated", { updatedAt: escapeHtml(formatShortTimestamp(item.updatedAt)) })}</span>
                </div>
              </div>
              <div class="card-actions">
                ${href ? `<a class="secondary-button text-btn action-btn-open" href="${escapeAttribute(href)}" target="_blank" rel="noreferrer">
                  <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                  ${escapeHtml(t("app.renderFeedbackList.open"))}
                </a>` : ""}
                <button class="icon-button" type="button" data-tooltip="${escapeAttribute(t("app.renderFeedbackList.editEvidence"))}" aria-label="${escapeAttribute(t("app.renderFeedbackList.editEvidence"))}" data-feedback-action="edit" data-id="${escapeAttribute(item.id)}">
                  <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                </button>
                <button class="icon-button danger-hover" type="button" data-tooltip="${escapeAttribute(t("app.renderFeedbackList.deleteEvidence"))}" aria-label="${escapeAttribute(t("app.renderFeedbackList.deleteEvidence"))}" data-feedback-action="delete" data-id="${escapeAttribute(item.id)}">
                  <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
                </button>
              </div>
            </div>
            <div class="feedback-card-body">
              <div class="feedback-evidence-details">
                <span><strong>${escapeHtml(t("app.renderFeedbackList.source2"))}</strong> ${escapeHtml(sourceLabel)}</span>
                <span><strong>${escapeHtml(t("app.renderFeedbackList.stage"))}</strong> ${escapeHtml(stageLabel)}</span>
                <span><strong>${escapeHtml(t("app.renderFeedbackList.area"))}</strong> ${escapeHtml(areaLabel)}</span>
                ${item.audience ? `<span><strong>${escapeHtml(t("app.renderFeedbackList.userOrGroup2"))}</strong> ${escapeHtml(item.audience)}</span>` : ""}
                ${item.contactName ? `<span><strong>${escapeHtml(t("app.renderFeedbackList.contact"))}</strong> ${escapeHtml(item.contactName)}</span>` : ""}
                ${item.relationshipDepth && item.relationshipDepth !== "none" ? `<span><strong>${escapeHtml(t("app.renderFeedbackList.relationship"))}</strong> ${escapeHtml(Options.label("feedbackRelationships", item.relationshipDepth))}</span>` : ""}
              </div>
              ${feedbackBlockSummaryHtml(item)}
              ${item.description ? `
              <div class="feedback-quote markdown-rendered">
                <div class="feedback-section-label">${escapeHtml(t("app.renderFeedbackList.whatHappened"))}</div>
                ${renderMarkdown(item.description)}
              </div>` : ""}
              ${item.outcome ? `
              <div class="feedback-outcome-block">
                <div class="action-title">${escapeHtml(t("app.renderFeedbackList.outcomeOrMetric"))}</div>
                <div class="action-content markdown-rendered">${renderMarkdown(item.outcome)}</div>
              </div>` : ""}
              ${item.action ? `
              <div class="feedback-action-block">
                <div class="action-title">
                  <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px;"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>
                  ${escapeHtml(t("ui.common.nextAction"))}
                </div>
                <div class="action-content markdown-rendered">${renderMarkdown(item.action)}</div>
              </div>` : ""}
              ${(item.tags || []).length ? `
              <div class="feedback-tags tag-pill-list">
                ${(item.tags || []).map((t) => `<span class="tag-pill tag-pill-readonly"${tagTooltipAttrs(t)}>${escapeHtml(t)}</span>`).join("")}
              </div>` : ""}
            </div>
          </article>
        `;
      })
      .join("");
    mountFeedbackAboutPicker();
    renderManagerPagination(elements.feedbackPagination, ordered.length, "feedbackPage");
  }

  function renderMediaControls() {
    if (!elements.mediaTargetsInput) return;

    mediaFormTargetsPicker();
    // The filter: all media, media used nowhere, or media used in one record.
    const filterValue = state.mediaTargetFilter || "all";
    const mode = filterValue === "all" || filterValue === "unused" ? filterValue : "record";
    if (elements.mediaTargetFilterMode) elements.mediaTargetFilterMode.value = mode;
    if (elements.mediaTargetFilter) {
      elements.mediaTargetFilter.hidden = mode !== "record";
      if (mode === "record") mediaTargetFilterPicker().setValue(filterValue.includes(":") ? [ItemPicker.parseKey(filterValue)] : []);
    }

    if (elements.mediaTagList) {
      elements.mediaTagList.innerHTML = getAllMediaTags()
        .map((tag) => `<option value="${escapeAttribute(tag)}">`)
        .join("");
    }
    // Types come from the shared list (Media > Options).
    if (elements.mediaTypeInput) {
      const current = elements.mediaTypeInput.value || "screenshot";
      elements.mediaTypeInput.innerHTML = Options.optionsHtml("mediaTypes", current);
    }
    if (elements.mediaTypeFilter) elements.mediaTypeFilter.innerHTML = Options.optionsHtml("mediaTypes", state.mediaTypeFilter || "all", { allLabel: t("extra.media.allTypes") });
    if (elements.mediaKindFilter) {
      const kind = state.mediaKindFilter || "all";
      elements.mediaKindFilter.innerHTML = [`<option value="all">${escapeHtml(t("extra.media.anyKind"))}</option>`, ...MEDIA_USED_IN_KINDS.map((entry) => `<option value="${entry}" ${entry === kind ? "selected" : ""}>${escapeHtml(t(`extra.kinds.${entry}`))}</option>`)].join("");
    }
    if (elements.mediaTagFilter) {
      const tag = state.mediaTagFilter || "all";
      elements.mediaTagFilter.innerHTML = [`<option value="all">${escapeHtml(t("extra.media.anyTag"))}</option>`, ...getAllMediaTags().map((entry) => `<option value="${escapeAttribute(entry)}" ${entry === tag ? "selected" : ""}>${escapeHtml(entry)}</option>`)].join("");
    }

    updateMediaSourceMode();
  }

  function renderMediaList() {
    if (!elements.mediaList) return;
    setExtraCount("media", state.mediaItems.length);
    const mediaItems = getFilteredMediaItems();

    if (!state.mediaItems.length) {
      elements.mediaList.innerHTML = extraEmptyStateHtml(t("extra.media.emptyTitle"), t("extra.media.emptyHint"));
      renderManagerPagination(elements.mediaPagination, 0, "mediaPage");
      return;
    }

    if (!mediaItems.length) {
      elements.mediaList.innerHTML = extraEmptyStateHtml(t("extra.noMatchTitle"), t("extra.noMatchHint"));
      renderManagerPagination(elements.mediaPagination, 0, "mediaPage");
      return;
    }

    const paged = getManagerPageItems(mediaItems, "mediaPage");
    elements.mediaList.innerHTML = paged.map(renderMediaCard).join("");
    mountMediaUsedInPicker();
    renderManagerPagination(elements.mediaPagination, mediaItems.length, "mediaPage");
  }

  function renderMediaCard(media) {
    const href = mediaOpenHref(media);
    const usedCount = mediaUsages(media).length;
    const tagsValue = (media.tags || []).join(", ");
    const sourceLabel = getMediaSourceLabel(media.sourceType);
    const sourceValue = mediaSourceDisplayValue(media);
    const isEditing = state.editingMediaItemId === media.id;

    if (isEditing) {
      return `
        <article class="manager-card media-card editing-card" data-media-id="${escapeAttribute(media.id)}">
          <div class="manager-card-header media-card-header">
            <div>
              <strong style="color: var(--accent);">${tHtml("app.renderMediaCard.editingAsset", { title: escapeHtml(media.title) })}</strong>
              <span>${escapeHtml(t("app.renderMediaCard.changesAreSavedAutomatically"))}</span>
            </div>
            <div class="card-actions">
              <button class="icon-button success-btn" type="button" data-tooltip="${escapeAttribute(t("app.renderMediaCard.doneEditing"))}" aria-label="${escapeAttribute(t("app.renderMediaCard.doneEditing"))}" data-media-action="done" data-id="${escapeAttribute(media.id)}">
                <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
              </button>
            </div>
          </div>
          <div class="media-card-body">
            ${renderMediaPreview(media)}
            <div class="manager-card-grid compact-grid media-card-grid">
              <label>
                ${escapeHtml(t("app.renderMediaCard.title"))}
                <input class="inline-input" type="text" value="${escapeAttribute(media.title)}" data-media-field="title" data-id="${escapeAttribute(media.id)}">
              </label>
              <label>
                ${escapeHtml(t("app.renderMediaCard.type"))}
                <select class="row-select" data-media-field="type" data-id="${escapeAttribute(media.id)}">
                  ${Options.optionsHtml("mediaTypes", media.type)}
                </select>
              </label>
              <label class="wide-field">
                ${escapeHtml(sourceLabel)}
                <input
                  class="inline-input"
                  type="text"
                  value="${escapeAttribute(sourceValue)}"
                  ${media.sourceType === "upload" ? "readonly" : `data-media-field="externalPath" data-id="${escapeAttribute(media.id)}"`}
                >
              </label>
              <label class="wide-field">
                ${escapeHtml(t("ui.common.tags"))}
                <input class="inline-input" type="text" value="${escapeAttribute(tagsValue)}" data-media-field="tags" data-id="${escapeAttribute(media.id)}" list="mediaTagList">
              </label>
              <label class="wide-field">
                ${escapeHtml(t("app.renderMediaCard.notes"))}
                <textarea class="auto-expand-field" data-media-field="notes" data-id="${escapeAttribute(media.id)}" rows="2">${escapeHtml(media.notes)}</textarea>
              </label>
              <div class="wide-field picker-field">
                <span>${escapeHtml(t("app.renderMediaCard.usedIn"))}</span>
                <div data-media-used-in="${escapeAttribute(media.id)}"></div>
              </div>
            </div>
          </div>
        </article>
      `;
    }

    return `
      <article class="manager-card media-card read-only-card" data-media-id="${escapeAttribute(media.id)}">
        <div class="manager-card-header media-card-header">
          <div>
            <strong>${escapeHtml(media.title)}</strong>
            <div class="card-meta">
              ${media.pinned ? `<span class="pinned-badge"><svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="currentColor"><path d="M12 17v5M9 2h6M10 2v7.586l-2.707 2.707A1 1 0 0 0 7 13v1h10v-1a1 1 0 0 0-.293-.707L14 9.586V2"></path></svg> ${escapeHtml(t("app.renderMediaCard.pinned"))}</span>` : ""}
              <span class="type-badge" data-type="${escapeAttribute(media.type)}">${escapeHtml(getMediaTypeLabel(media.type).toUpperCase())}</span>
              <span class="source-badge" data-source="${escapeAttribute(media.sourceType)}">${escapeHtml(sourceLabel.toUpperCase())}</span>
              <span class="meta-item"><svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle></svg> ${escapeHtml(t("app.counts.target", { count: usedCount }))}</span>
              <span class="meta-item"><svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg> ${tHtml("app.renderMediaCard.updated", { updatedAt: escapeHtml(formatShortTimestamp(media.updatedAt)) })}</span>
            </div>
          </div>
          <div class="card-actions">
            ${canPreviewMediaDocument(media) ? `<button class="secondary-button text-btn action-btn-open" type="button" data-media-action="preview-document" data-id="${escapeAttribute(media.id)}">
              <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;"><path d="M6 3h8l5 5v13H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm7 2H6v14h11V9h-4V5Z"></path></svg>
              ${escapeHtml(t("app.renderMediaCard.view"))}
            </button>` : ""}
            ${href ? `<a class="secondary-button text-btn action-btn-open" href="${escapeAttribute(href)}" target="_blank" rel="noreferrer">
              <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
              ${escapeHtml(t("app.renderMediaCard.open"))}
            </a>` : ""}
            <button class="icon-button ${media.pinned ? "active-pin" : ""}" type="button" data-tooltip="${media.pinned ? t("app.renderMediaCard.unpinAsset") : t("app.renderMediaCard.pinAssetToTop")}" aria-label="${media.pinned ? t("app.renderMediaCard.unpinAsset") : t("app.renderMediaCard.pinAssetToTop")}" data-media-action="toggle-pin" data-id="${escapeAttribute(media.id)}">
              <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.5" fill="${media.pinned ? "currentColor" : "none"}" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5M9 2h6M10 2v7.586l-2.707 2.707A1 1 0 0 0 7 13v1h10v-1a1 1 0 0 0-.293-.707L14 9.586V2"></path></svg>
            </button>
            <button class="icon-button" type="button" data-tooltip="${escapeAttribute(t("extra.media.copy"))}" aria-label="${escapeAttribute(t("extra.media.copy"))}" data-media-action="copy" data-id="${escapeAttribute(media.id)}">
              <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            </button>
            <button class="icon-button" type="button" data-tooltip="${escapeAttribute(t("app.renderMediaCard.editAsset"))}" aria-label="${escapeAttribute(t("app.renderMediaCard.editAsset"))}" data-media-action="edit" data-id="${escapeAttribute(media.id)}">
              <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            </button>
            <button class="icon-button danger-hover" type="button" data-tooltip="${escapeAttribute(t("app.renderMediaCard.deleteAsset"))}" aria-label="${escapeAttribute(t("app.renderMediaCard.deleteAsset"))}" data-media-action="delete" data-id="${escapeAttribute(media.id)}">
              <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
            </button>
          </div>
        </div>
        <div class="media-card-body">
          ${renderMediaPreview(media)}
          <div class="media-details-content">
            ${media.notes ? `
            <div class="detail-section">
              <div class="section-title">${escapeHtml(t("app.renderMediaCard.notes"))}</div>
              <div class="section-body">${escapeHtml(media.notes)}</div>
            </div>` : ""}
            ${media.tags && media.tags.length ? `
            <div class="detail-section">
              <div class="section-title">${escapeHtml(t("ui.common.tags"))}</div>
              <div class="media-tags-list">
                ${media.tags.map((tag) => `<span class="media-tag">${escapeHtml(tag)}</span>`).join("")}
              </div>
            </div>` : ""}
            ${sourceValue ? `
            <div class="detail-section">
              <div class="section-title">${escapeHtml(sourceLabel)}</div>
              ${renderMediaSourceBlock(media, sourceValue)}
            </div>` : ""}
          </div>
        </div>
        ${state.copyingMediaId === media.id ? renderMediaCopyRow(media) : ""}
        ${usedCount ? `
        <div class="media-used-section">
          <div class="media-used-title">${escapeHtml(t("app.renderMediaCard.usedIn2"))}</div>
          ${renderMediaUsageList(media)}
        </div>` : ""}
      </article>
    `;
  }

  // ---- Copy to another startup ------------------------------------------------
  // The copy takes the file and its details, not its links ("Used in" points
  // at this startup's records).

  let mediaCopyStartups = null;

  async function openMediaCopy(media) {
    state.copyingMediaId = media.id;
    if (!mediaCopyStartups) {
      try {
        const response = await fetch(Api.urls.startups, { cache: "no-store" });
        const body = await response.json();
        mediaCopyStartups = (body.startups || []).filter((startup) => !startup.archived && startup.id !== STARTUP_ID);
      } catch {
        mediaCopyStartups = [];
      }
    }
    renderMediaList();
    elements.mediaList?.querySelector(`[data-media-copy-to="${cssEscape(media.id)}"]`)?.focus();
  }

  function renderMediaCopyRow(media) {
    const others = mediaCopyStartups || [];
    if (!others.length) {
      return `<div class="media-copy-row" role="group"><p>${escapeHtml(t("extra.media.copyNoOther"))}</p><button class="secondary-button compact" type="button" data-media-action="copy-cancel" data-id="${escapeAttribute(media.id)}">${escapeHtml(t("extra.cancel"))}</button></div>`;
    }
    return `
      <div class="media-copy-row" role="group" aria-label="${escapeAttribute(t("extra.media.copy"))}">
        <label>${escapeHtml(t("extra.media.copyTo"))}
          <select data-media-copy-to="${escapeAttribute(media.id)}">${others.map((startup) => `<option value="${escapeAttribute(startup.id)}">${escapeHtml(startup.name)}</option>`).join("")}</select>
        </label>
        <button class="primary-button compact" type="button" data-media-action="copy-confirm" data-id="${escapeAttribute(media.id)}">${escapeHtml(t("extra.media.copyButton"))}</button>
        <button class="secondary-button compact" type="button" data-media-action="copy-cancel" data-id="${escapeAttribute(media.id)}">${escapeHtml(t("extra.cancel"))}</button>
        <p class="settings-hint">${escapeHtml(t("extra.media.copyHint"))}</p>
      </div>`;
  }

  async function copyMediaToStartup(media, startupId) {
    if (!startupId) return;
    const target = (mediaCopyStartups || []).find((startup) => startup.id === startupId);
    // The server copies what it holds, so this item's latest edits go first.
    const saved = await persist(t("app.copyMediaToStartup.saved"));
    if (!saved) {
      window.alert(t("extra.media.copySaveFirst"));
      return;
    }
    try {
      const response = await fetch(Api.api("/media/copy"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaId: media.id, to: startupId, origin: "ui" }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
      state.copyingMediaId = null;
      markSaved(t("extra.media.copied", { name: target?.name || startupId }));
      renderMediaList();
    } catch (error) {
      window.alert(t("extra.media.copyFailed", { message: error.message }));
    }
  }

  function renderMediaPreview(media) {
    const href = mediaOpenHref(media);
    const iconId = media.type === "video" ? "icon-video" : media.type === "document" ? "icon-file" : "icon-image";

    if (href && isImageMedia(media, href)) {
      return `<a class="media-preview media-preview-image" href="${escapeAttribute(href)}" target="_blank" rel="noreferrer"><img src="${escapeAttribute(href)}" alt="${escapeAttribute(media.title)}" loading="lazy" decoding="async"></a>`;
    }

    if (href && isVideoMedia(media, href)) {
      return `<div class="media-preview media-preview-video"><video src="${escapeAttribute(href)}" controls preload="metadata"></video></div>`;
    }

    if (canPreviewMediaDocument(media)) {
      return `
        <button class="media-preview media-preview-file media-preview-button" type="button" data-media-action="preview-document" data-id="${escapeAttribute(media.id)}">
          <svg><use href="#${iconId}"></use></svg>
          <span>${escapeHtml(media.originalName || media.filePath || getMediaTypeLabel(media.type))}</span>
          <small>${escapeHtml(t("app.renderMediaPreview.markdownDocument"))}</small>
        </button>
      `;
    }

    return `
      <div class="media-preview media-preview-file">
        <svg><use href="#${iconId}"></use></svg>
        <span>${escapeHtml(media.originalName || media.externalPath || media.filePath || getMediaTypeLabel(media.type))}</span>
        ${media.size ? `<small>${escapeHtml(formatBytes(media.size))}</small>` : ""}
      </div>
    `;
  }

  // Where a media file is used: one link per record, each with the
  // placement and the published URL.
  function mediaUsages(media) {
    return visibleLinksOf("media", media.id).filter((entry) => entry.link.relation === "uses");
  }

  function renderMediaUsageList(media) {
    const usages = mediaUsages(media);
    if (!usages.length) {
      return `<div class="media-used-empty">${escapeHtml(t("app.renderMediaUsageList.notUsedAnywhereYet"))}</div>`;
    }

    return `
      <div class="media-used-list">
        ${usages
          .map((entry) => {
            const item = describeRecord(entry.other);
            const resultHref = safeLink(entry.link.resultLink);
            return `
              <div class="media-used-item">
                <div class="media-used-target"${item.section ? ` data-section="${item.section}"` : ""}>
                  ${item.section ? `<span class="section-dot" aria-hidden="true"></span>` : ""}
                  <button class="media-used-target-button" type="button" data-link-open="${escapeAttribute(`${entry.other.kind}:${entry.other.id}`)}">${escapeHtml(item.title)}</button>
                  ${resultHref ? `<a class="media-used-result" href="${escapeAttribute(resultHref)}" target="_blank" rel="noreferrer">${escapeHtml(t("app.renderMediaUsageList.result"))}</a>` : ""}
                </div>
                <input
                  class="inline-input"
                  type="text"
                  value="${escapeAttribute(entry.link.context)}"
                  placeholder="${escapeAttribute(t("app.renderMediaUsageList.placementCropCaptionVersion"))}"
                  data-media-usage-field="context"
                  data-media-link-id="${escapeAttribute(entry.link.id)}"
                  data-id="${escapeAttribute(media.id)}"
                >
                <input
                  class="inline-input"
                  type="url"
                  value="${escapeAttribute(entry.link.resultLink)}"
                  placeholder="${escapeAttribute(t("app.renderMediaUsageList.publishedUrl"))}"
                  data-media-usage-field="resultLink"
                  data-media-link-id="${escapeAttribute(entry.link.id)}"
                  data-id="${escapeAttribute(media.id)}"
                >
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  }

  // "Used in" for a new media file, and the filter's record.
  let mediaFormTargetsPickerInstance = null;
  function mediaFormTargetsPicker() {
    if (!mediaFormTargetsPickerInstance && elements.mediaTargetsInput) {
      mediaFormTargetsPickerInstance = createItemPicker(elements.mediaTargetsInput, {
        kinds: MEDIA_USED_IN_KINDS,
        label: t("app.mediaFormTargetsPicker.usedIn"),
        placeholder: t("extra.media.usedInPlaceholder"),
        recentName: "media-used-in",
      });
    }
    return mediaFormTargetsPickerInstance;
  }

  let mediaTargetFilterPickerInstance = null;
  function mediaTargetFilterPicker() {
    if (!mediaTargetFilterPickerInstance && elements.mediaTargetFilter) {
      mediaTargetFilterPickerInstance = createItemPicker(elements.mediaTargetFilter, {
        multiple: false,
        kinds: MEDIA_USED_IN_KINDS,
        label: t("app.mediaTargetFilterPicker.usedIn"),
        placeholder: t("app.mediaTargetFilterPicker.pickARecord"),
        recentName: "media-filter",
      });
    }
    return mediaTargetFilterPickerInstance;
  }

  // The "Used in" picker of the media card being edited. Changes save at once.
  function mountMediaUsedInPicker() {
    const holder = elements.mediaList?.querySelector("[data-media-used-in]");
    if (!holder) return;
    const mediaId = holder.dataset.mediaUsedIn;
    createItemPicker(holder, {
      kinds: MEDIA_USED_IN_KINDS,
      label: t("app.mountMediaUsedInPicker.usedIn"),
      placeholder: t("extra.media.usedInPlaceholder"),
      recentName: "media-used-in",
      value: linkedRefs("media", mediaId, "uses", "b"),
      onChange: (refs) => {
        setLinkedRefs("media", mediaId, "uses", "b", refs);
        persist(t("app.mountMediaUsedInPicker.mediaLinksUpdated"));
      },
    });
  }

  function shiftDateISO(iso, days) {
    if (!Dates.isDateString(iso)) return todayDate();
    return Dates.addDays(iso, days);
  }

  function getManagerPageItems(items, pageKey) {
    const page = clampManagerPage(pageKey, items.length);
    const start = (page - 1) * MANAGER_PAGE_SIZE;
    return items.slice(start, start + MANAGER_PAGE_SIZE);
  }

  function renderManagerPagination(container, total, pageKey) {
    if (!container) return;
    if (!total) {
      container.innerHTML = "";
      return;
    }

    const page = clampManagerPage(pageKey, total);
    const totalPages = Math.max(1, Math.ceil(total / MANAGER_PAGE_SIZE));
    const start = (page - 1) * MANAGER_PAGE_SIZE + 1;
    const end = Math.min(total, page * MANAGER_PAGE_SIZE);

    container.innerHTML = `
      <span class="page-summary">${tHtml("app.renderManagerPagination.showingOf", { start, end, total })}</span>
      <button class="secondary-button" type="button" data-manager-page-key="${escapeAttribute(pageKey)}" data-manager-page="${Math.max(1, page - 1)}" ${page <= 1 ? "disabled" : ""}>${escapeHtml(t("app.renderManagerPagination.previous"))}</button>
      <span class="page-summary">${tHtml("app.renderManagerPagination.page", { page, totalPages })}</span>
      <button class="secondary-button" type="button" data-manager-page-key="${escapeAttribute(pageKey)}" data-manager-page="${Math.min(totalPages, page + 1)}" ${page >= totalPages ? "disabled" : ""}>${escapeHtml(t("app.renderManagerPagination.next"))}</button>
    `;
  }

  function clampManagerPage(pageKey, total) {
    const totalPages = Math.max(1, Math.ceil(total / MANAGER_PAGE_SIZE));
    const page = Math.min(Math.max(1, Number(state[pageKey]) || 1), totalPages);
    state[pageKey] = page;
    return page;
  }

  // Every status, grouped by status group. Sections no longer have lists of
  // their own: MK, PO, FU and Company share one.
  function renderStatusOptions(selected) {
    return Statuses.optionsHtml(selected, { unmappedLabel: t("statusFilter.unmapped") });
  }

  function getFilteredItems() {
    const cacheKey = JSON.stringify([
      derivedDataRevision,
      state.search,
      selectedTaxonomyNode("mk"),
      state.statusFilter,
      state.priorityFilter,
      state.campaignFilter,
      state.pipelinePresetFilter,
      state.tagFilter,
      state.extraParamFilter,
    ]);
    if (pipelineFilterCache && pipelineFilterCache.key === cacheKey) {
      return pipelineFilterCache.items.slice();
    }

    const query = state.search.toLowerCase();
    const today = todayDate();
    const currentMonth = today.slice(0, 7);
    const weekAheadStr = Dates.addDays(today, 7);

    const filtered = state.items.filter((item) => {
      const matchesCategory = matchesTaxonomyTabs("mk", item);
      const matchesStatus = state.statusFilter === "all" || item.status === state.statusFilter;
      const matchesPriority = state.priorityFilter === "all" || item.priority === state.priorityFilter;
      const matchesCampaign = state.campaignFilter === "all" || item.campaignId === state.campaignFilter;
      const haystack = `${item.id || ""} ${item.platform} ${item.link} ${item.notes} ${(item.tags || []).join(" ")} ${getCategory(item.category).name} ${getCampaignName(item.campaignId)}`.toLowerCase();
      const matchesSearch = !query || haystack.includes(query);

      const itemTags = item.tags || [];
      const matchesTags =
        state.tagFilter.length === 0 || state.tagFilter.every((t) => itemTags.includes(t));

      const matchesExtraParams =
        state.extraParamFilter.length === 0 ||
        state.extraParamFilter.every((f) => {
          const val = (item.extraParams && item.extraParams[f.paramId]) || "";
          return String(val) === String(f.value);
        });

      const isOpen = Statuses.isOpen(item.status);
      const matchesPreset =
        state.pipelinePresetFilter === "all" ||
        (state.pipelinePresetFilter === "overdue" && isOpen && !!item.date && item.date < today) ||
        (state.pipelinePresetFilter === "due-this-week" && !!item.date && item.date >= today && item.date <= weekAheadStr) ||
        (state.pipelinePresetFilter === "this-month" && !!item.date && item.date.slice(0, 7) === currentMonth) ||
        (state.pipelinePresetFilter === "needs-followup" && isOpen) ||
        (state.pipelinePresetFilter === "no-campaign" && !item.campaignId) ||
        (state.pipelinePresetFilter === "warm-contact" && itemTags.includes("warm-contact")) ||
        (state.pipelinePresetFilter === "high-priority" && ["Very High", "High"].includes(item.priority));

      return (
        matchesCategory &&
        matchesStatus &&
        matchesPriority &&
        matchesCampaign &&
        matchesSearch &&
        matchesTags &&
        matchesExtraParams &&
        matchesPreset
      );
    });

    pipelineFilterCache = { key: cacheKey, items: filtered };
    return filtered.slice();
  }

  function getFilteredMediaItems() {
    const cacheKey = JSON.stringify([
      derivedDataRevision,
      state.mediaSearch,
      state.mediaTypeFilter,
      state.mediaSourceFilter,
      state.mediaTargetFilter,
      state.mediaKindFilter,
      state.mediaTagFilter,
    ]);
    if (mediaFilterCache && mediaFilterCache.key === cacheKey) {
      return mediaFilterCache.items.slice();
    }

    const query = state.mediaSearch.toLowerCase();
    const typeFilter = state.mediaTypeFilter || "all";
    const sourceFilter = state.mediaSourceFilter || "all";
    const targetFilter = state.mediaTargetFilter || "all";
    const kindFilter = state.mediaKindFilter || "all";
    const tagFilter = state.mediaTagFilter || "all";

    const filtered = state.mediaItems
      .filter((media) => {
        const matchesType = typeFilter === "all" || media.type === typeFilter;
        const matchesSource = sourceFilter === "all" || media.sourceType === sourceFilter;
        const usages = mediaUsages(media);
        const usedKeys = usages.map((entry) => `${entry.other.kind}:${entry.other.id}`);
        const matchesTarget =
          targetFilter === "all" ||
          (targetFilter === "unused" && usedKeys.length === 0) ||
          (targetFilter === "record" ? false : usedKeys.includes(targetFilter));
        const targetNames = usages.map((entry) => describeRecord(entry.other)?.title || "").join(" ");
        const usageNotes = usages.map((entry) => `${entry.link.context} ${entry.link.resultLink}`).join(" ");
        const haystack = `${media.title} ${media.type} ${media.sourceType} ${media.filePath} ${media.absolutePath} ${media.externalPath} ${media.originalName} ${media.notes} ${(media.tags || []).join(" ")} ${targetNames} ${usageNotes}`.toLowerCase();
        const matchesSearch = !query || haystack.includes(query);
        const matchesKind = kindFilter === "all" || usages.some((entry) => entry.other.kind === kindFilter);
        const matchesTag = tagFilter === "all" || (media.tags || []).includes(tagFilter);

        return matchesType && matchesSource && matchesTarget && matchesKind && matchesTag && matchesSearch;
      })
      .sort((a, b) => {
        if (Boolean(b.pinned) !== Boolean(a.pinned)) {
          return b.pinned ? 1 : -1;
        }
        return String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.title.localeCompare(b.title);
      });

    mediaFilterCache = { key: cacheKey, items: filtered };
    return filtered.slice();
  }

  function handleCampaignFormSubmit(event) {
    event.preventDefault();
    if (!elements.campaignNameInput.value.trim()) {
      elements.campaignNameInput.focus();
      return;
    }

    const campaign = normalizeCampaign({
      id: makeId(),
      name: elements.campaignNameInput.value,
      status: elements.campaignStatusInput.value,
      startDate: elements.campaignStartInput.value,
      endDate: elements.campaignEndInput.value,
      goal: elements.campaignGoalInput.value,
      hypothesis: elements.campaignHypothesisInput.value,
      successMetric: elements.campaignSuccessMetricInput.value,
      description: elements.campaignDescriptionInput.value,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    if (!campaign) return;
    state.campaigns.unshift(campaign);
    state.campaignPage = 1;
    resetCampaignForm();
    persist(t("app.handleCampaignFormSubmit.campaignAdded"));
    render();
  }

  function handleTagFormSubmit(event) {
    event.preventDefault();
    const tagId = normalizeTagId(elements.tagLabelInput.value);
    if (!tagId) {
      elements.tagLabelInput.focus();
      return;
    }

    const def = ensureTagDefinition(tagId);
    def.label = tagId;
    const description = String(elements.tagDescriptionInput.value || "").trim();
    if (description || !def.description) {
      def.description = description;
    }
    const color = elements.tagColorInput?.dataset.touched === "1" ? elements.tagColorInput.value.toLowerCase() : "";
    if (/^#[0-9a-f]{6}$/.test(color)) def.color = color;
    state.editingTagId = tagId;
    const records = getFilteredTagRecords(getAllTagRecords());
    const index = records.findIndex((record) => record.id === tagId);
    state.tagPage = index >= 0 ? Math.floor(index / MANAGER_PAGE_SIZE) + 1 : 1;
    resetTagForm();
    persist(t("app.handleTagFormSubmit.tagAdded"));
    render();
  }

  function handleDailyFormSubmit(event) {
    event.preventDefault();
    if (!elements.dailyTitleInput.value.trim()) {
      elements.dailyTitleInput.focus();
      return;
    }

    const normalizedUrls = normalizeDailyUrlList(elements.dailyUrlInput.value);
    if (!normalizedUrls) {
      elements.dailyUrlInput.focus();
      return;
    }

    const link = normalizeDailyLink({
      id: makeId(),
      subcategory: elements.dailySubcategoryInput.value,
      title: elements.dailyTitleInput.value,
      url: normalizedUrls,
      description: elements.dailyDescriptionInput.value,
      active: elements.dailyActiveInput.checked,
      shared: Boolean(elements.dailySharedInput?.checked),
      priority: elements.dailyPriorityInput.value,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    if (!link) return;
    state.dailyLinks.unshift(link);
    resetDailyForm();
    persist(t("app.handleDailyFormSubmit.researchLinkAdded"));
    render();
  }

  function handleFeedbackFormSubmit(event) {
    event.preventDefault();
    if (!elements.feedbackTitleInput.value.trim()) {
      elements.feedbackTitleInput.focus();
      return;
    }

    const now = new Date().toISOString();
    const item = normalizeFeedbackItem({
      id: makeId(),
      type: elements.feedbackTypeInput.value,
      status: elements.feedbackStatusInput.value,
      source: elements.feedbackSourceInput?.value,
      audience: elements.feedbackAudienceInput?.value,
      contactName: elements.feedbackContactInput?.value,
      relationshipDepth: elements.feedbackRelationshipInput?.value,
      stage: elements.feedbackStageInput?.value,
      area: elements.feedbackAreaInput?.value,
      evidenceLevel: elements.feedbackEvidenceInput?.value,
      title: elements.feedbackTitleInput.value,
      link: elements.feedbackLinkInput.value,
      description: elements.feedbackDescriptionInput.value,
      outcome: elements.feedbackOutcomeInput?.value,
      action: elements.feedbackActionInput.value,
      ...readFeedbackFormBlock(),
      createdAt: now,
      updatedAt: now,
    });

    if (!item) return;
    state.feedbackItems.unshift(item);
    state.links = Links.mergeLinks(state.links, feedbackAboutPicker().getValue().map((ref) => Links.makeLink({ kind: "feedback", id: item.id }, ref, "feedback-about")));
    state.feedbackPage = 1;
    resetFeedbackForm();
    persist(t("app.handleFeedbackFormSubmit.evidenceAdded"));
    render();
  }

  async function handleMediaFormSubmit(event) {
    event.preventDefault();

    const sourceType = elements.mediaSourceInput.value;
    const file = elements.mediaFileInput.files && elements.mediaFileInput.files[0];
    const externalPath = elements.mediaPathInput.value.trim();
    const usedIn = mediaFormTargetsPicker().getValue();
    let upload = null;
    let title = elements.mediaTitleInput.value.trim();

    if (sourceType === "upload") {
      if (!file) {
        elements.mediaFileInput.focus();
        return;
      }
      if (!title) title = file.name;

      const progressWrap = document.querySelector("#mediaUploadProgressWrap");
      const progressText = document.querySelector("#mediaUploadProgressText");
      const progressPercent = document.querySelector("#mediaUploadProgressPercent");
      const progressFill = document.querySelector("#mediaUploadProgressFill");
      const submitBtn = elements.mediaForm ? elements.mediaForm.querySelector("button[type='submit']") : null;

      if (progressWrap) progressWrap.hidden = false;
      if (submitBtn) submitBtn.disabled = true;

      const updateProgress = (percent) => {
        const msg = t("app.handleMediaFormSubmit.uploading", { name: file.name });
        if (progressText) progressText.textContent = msg;
        if (progressPercent) progressPercent.textContent = `${percent}%`;
        if (progressFill) progressFill.style.width = `${percent}%`;
        markSaved(`${msg} ${percent}%`);
      };

      updateProgress(0);
      upload = await uploadMediaFile(file, updateProgress);
      updateProgress(100);

      if (progressWrap) progressWrap.hidden = true;
      if (submitBtn) submitBtn.disabled = false;

      if (!upload) return;
    } else {
      if (!externalPath) {
        elements.mediaPathInput.focus();
        return;
      }
      if (!title) title = mediaTitleFromPath(externalPath);
    }

    if (!title) {
      elements.mediaTitleInput.focus();
      return;
    }

    const media = normalizeMediaItem({
      id: makeId(),
      title,
      type: elements.mediaTypeInput.value,
      sourceType,
      filePath: upload?.path || "",
      absolutePath: upload?.absolutePath || "",
      externalPath: sourceType === "upload" ? "" : externalPath,
      originalName: upload?.originalName || "",
      storedName: upload?.storedName || "",
      mimeType: upload?.mimeType || "",
      size: upload?.size || 0,
      tags: parseTagList(elements.mediaTagsInput.value),
      notes: elements.mediaNotesInput.value,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    if (!media) return;
    state.mediaItems.unshift(media);
    // "Used in": the records picked in the form use this media.
    state.links = Links.mergeLinks(state.links, usedIn.map((ref) => Links.makeLink(ref, { kind: "media", id: media.id }, "uses")));
    mediaFormTargetsPicker().setValue([]);
    state.mediaPage = 1;
    await persist(t("app.handleMediaFormSubmit.mediaAdded"));
    resetMediaForm();
    render();
  }

  async function uploadMediaFile(file, onProgress) {
    if (!state.apiReady) {
      markSaved(SAVE_STATE.offline);
      return null;
    }

    markSaved(t("app.uploadMediaFile.uploadingMedia"));
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      const body = new FormData();
      body.append("file", file);

      if (xhr.upload) {
        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable && typeof onProgress === "function") {
            const percent = Math.round((e.loaded / e.total) * 100);
            onProgress(percent);
          }
        });
      }

      xhr.addEventListener("load", () => {
        let payload = {};
        try {
          payload = JSON.parse(xhr.responseText || "{}");
        } catch {}
        if (xhr.status >= 200 && xhr.status < 300 && payload.ok !== false) {
          resolve(payload);
        } else {
          markSaved(t("app.uploadMediaFile.uploadFailed"));
          resolve(null);
        }
      });

      xhr.addEventListener("error", () => {
        markSaved(t("app.uploadMediaFile.uploadFailed"));
        resolve(null);
      });

      xhr.addEventListener("abort", () => {
        markSaved(t("app.uploadMediaFile.uploadCancelled"));
        resolve(null);
      });

      xhr.open("POST", API_MEDIA_UPLOAD_URL);
      xhr.send(body);
    });
  }

  function handleCampaignFieldInput(field, immediate = false) {
    const campaign = findCampaign(field.dataset.id);
    if (!campaign) return;
    const nextValue = normalizeCampaignFieldValue(field.dataset.campaignField, field.value);
    if (campaign[field.dataset.campaignField] === nextValue) {
      if (immediate) {
        renderCampaigns();
      }
      return;
    }

    campaign[field.dataset.campaignField] = nextValue;
    campaign.updatedAt = new Date().toISOString();
    scheduleAutosave();
    if (immediate) {
      renderCampaigns();
    }
  }

  function addCampaignTag(campaignId, raw) {
    const campaign = findCampaign(campaignId);
    if (!campaign) return;
    const [tag] = normalizeTagArray([raw]);
    if (!tag || (campaign.tags || []).includes(tag)) return;
    campaign.tags = [...(campaign.tags || []), tag];
    campaign.updatedAt = new Date().toISOString();
    scheduleAutosave();
    renderCampaigns();
  }

  function removeCampaignTag(campaignId, tag) {
    const campaign = findCampaign(campaignId);
    if (!campaign) return;
    if (!(campaign.tags || []).includes(tag)) return;
    campaign.tags = (campaign.tags || []).filter((t) => t !== tag);
    campaign.updatedAt = new Date().toISOString();
    scheduleAutosave();
    renderCampaigns();
  }

  function focusCampaignTagInput(campaignId) {
    if (!elements.campaignList) return;
    const input = Array.from(elements.campaignList.querySelectorAll("[data-campaign-tag-input]")).find((el) => el.dataset.id === campaignId);
    if (input) input.focus();
  }

  function handleTagFieldInput(field, immediate = false) {
    const tagId = normalizeTagId(field.dataset.id);
    if (!tagId) return;
    const fieldName = field.dataset.tagField;
    if (fieldName !== "description" && fieldName !== "color") return;
    const def = ensureTagDefinition(tagId);

    const nextValue = fieldName === "color" ? (/^#[0-9a-f]{6}$/i.test(field.value) ? field.value.toLowerCase() : "") : String(field.value || "");
    if ((def[fieldName] || "") === nextValue) {
      if (immediate) renderTags();
      return;
    }

    if (nextValue) def[fieldName] = nextValue;
    else delete def[fieldName];
    def.label = def.label || tagId;
    scheduleAutosave();

    if (immediate) {
      renderTags();
    }
  }

  function handleDailyFieldInput(field, immediate = false) {
    const link = findDailyLink(field.dataset.id);
    if (!link) return;
    const fieldName = field.dataset.dailyField;
    const rawValue = field.type === "checkbox" ? field.checked : field.value;
    const nextValue = normalizeDailyFieldValue(fieldName, rawValue);
    if (link[fieldName] === nextValue) {
      if (immediate && state.editingDailyLinkId !== link.id) renderDailyGroups();
      return;
    }

    link[fieldName] = nextValue;
    link.updatedAt = new Date().toISOString();
    scheduleAutosave();
    if (immediate && state.editingDailyLinkId !== link.id) {
      renderDailyGroups();
    }
  }

  function handleAiFieldInput(field, immediate = false) {
    const account = findAiAccount(field.dataset.id);
    if (!account) return;
    const fieldName = field.dataset.aiField;
    const rawValue = field.type === "checkbox" ? field.checked : field.value;
    const nextValue = fieldName === "links"
      ? normalizeAiLinks(field.value)
      : fieldName === "kind"
        ? (field.value === "subscription" ? "subscription" : "api")
        : fieldName === "strikethrough"
          ? Boolean(rawValue)
          : String(field.value || "").trim();
    const currentValue = fieldName === "links" ? account.links : account[fieldName];
    if (JSON.stringify(currentValue) === JSON.stringify(nextValue)) {
      if (immediate && state.editingAiAccountId !== account.id) renderAiGroups();
      return;
    }

    account[fieldName] = nextValue;
    scheduleAutosave();
    if (immediate && state.editingAiAccountId !== account.id) {
      renderAiGroups();
    }
  }

  function handleAiFlowFieldInput(field, immediate = false) {
    const item = findAiFlowItem(field.dataset.id);
    if (!item) return;
    const fieldName = field.dataset.aiFlowField;
    const nextValue = String(field.value || "").trim();
    if (item[fieldName] === nextValue) return;
    item[fieldName] = nextValue;
    scheduleAutosave();
    if (immediate && !state.isEditingAllAiFlow && !state.editingAiFlowIds.has(item.id)) {
      renderAiFlow();
    }
  }

  function handleFeedbackFieldInput(field, immediate = false) {
    const item = findFeedbackItem(field.dataset.id);
    if (!item) return;
    const fieldName = field.dataset.feedbackField;
    const nextValue = normalizeFeedbackFieldValue(fieldName, field.value);
    if (item[fieldName] === nextValue) {
      if (immediate && state.editingFeedbackItemId !== item.id) renderFeedbackList();
      return;
    }

    item[fieldName] = nextValue;
    item.updatedAt = new Date().toISOString();
    scheduleAutosave();
    if (immediate && state.editingFeedbackItemId !== item.id) {
      renderFeedbackList();
    }
  }

  function addFeedbackTag(feedbackId, raw) {
    const item = findFeedbackItem(feedbackId);
    if (!item) return;
    const [tag] = normalizeTagArray([raw]);
    if (!tag || (item.tags || []).includes(tag)) return;
    item.tags = [...(item.tags || []), tag];
    item.updatedAt = new Date().toISOString();
    scheduleAutosave();
    renderFeedbackList();
  }

  function removeFeedbackTag(feedbackId, tag) {
    const item = findFeedbackItem(feedbackId);
    if (!item) return;
    if (!(item.tags || []).includes(tag)) return;
    item.tags = (item.tags || []).filter((t) => t !== tag);
    item.updatedAt = new Date().toISOString();
    scheduleAutosave();
    renderFeedbackList();
  }

  function focusFeedbackTagInput(feedbackId) {
    if (!elements.feedbackList) return;
    const input = Array.from(elements.feedbackList.querySelectorAll("[data-feedback-tag-input]")).find((el) => el.dataset.id === feedbackId);
    if (input) input.focus();
  }

  function handleMediaFieldInput(field, immediate = false) {
    const media = findMediaItem(field.dataset.id);
    if (!media) return;
    const fieldName = field.dataset.mediaField;

    const nextValue = normalizeMediaFieldValue(fieldName, field.value);
    if (media[fieldName] === nextValue) {
      if (immediate) renderMediaList();
      return;
    }

    media[fieldName] = nextValue;
    media.updatedAt = new Date().toISOString();
    scheduleAutosave();
    if (immediate) {
      renderMediaControls();
      renderMediaList();
    }
  }

  function handleMediaUsageFieldInput(field) {
    // The placement and the published URL live on the link.
    const link = state.links.find((entry) => entry.id === field.dataset.mediaLinkId);
    if (!link) return;
    const fieldName = field.dataset.mediaUsageField;
    link[fieldName] = fieldName === "resultLink" ? cleanStoredLink(field.value) : String(field.value || "").trim();
    scheduleAutosave();
  }

  function normalizeCampaignFieldValue(field, value) {
    const nextValue = String(value ?? "").trim();
    if (field === "status") {
      return nextValue ? String(nextValue) : (Statuses.campaignStatuses()[0]?.id || "planned");
    }
    if (field === "startDate" || field === "endDate") {
      return /^\d{4}-\d{2}-\d{2}$/.test(nextValue) ? nextValue : "";
    }
    if (field === "name") {
      return nextValue || "Untitled campaign";
    }
    return nextValue;
  }

  function normalizeDailyFieldValue(field, value) {
    if (field === "active" || field === "shared") return Boolean(value);
    const nextValue = String(value ?? "").trim();
    if (field === "subcategory") return researchGroupId(nextValue);
    if (field === "priority") {
      return dailyPriorities.includes(nextValue) ? nextValue : "Medium";
    }
    if (field === "title") {
      return nextValue || "Untitled link";
    }
    if (field === "url") {
      return normalizeDailyUrlList(nextValue);
    }
    return nextValue;
  }

  function normalizeFeedbackFieldValue(field, value) {
    const nextValue = String(value ?? "").trim();
    if (field === "status") return feedbackStatuses.includes(nextValue) ? nextValue : "new";
    if (field === "repeatUsageCount") return normalizeFeedbackRepeatUsageCount(nextValue);
    if (field === "nextReviewDate" || field === "nextActionDate") return /^\d{4}-\d{2}-\d{2}$/.test(nextValue) ? nextValue : "";
    if (field === "title") return nextValue || "Untitled feedback";
    return nextValue;
  }

  function normalizeMediaFieldValue(field, value) {
    const nextValue = String(value ?? "").trim();
    if (field === "title") {
      return nextValue || "Untitled media";
    }
    if (field === "tags") {
      return parseTagList(nextValue);
    }
    return nextValue;
  }

  function handleInlineInput(event) {
    const field = event.target.closest("[data-inline-field]");
    if (!field || isImmediateField(field)) return;

    if (field.dataset.inlineField === "notes") {
      autoResizeTextarea(field);
    }

    const item = findItem(field.dataset.id);
    if (!item) return;

    updateItemField(item, field.dataset.inlineField, field.value);
    scheduleAutosave();
  }

  function handleInlineBlur(event) {
    const field = event.target.closest("[data-inline-field]");
    if (!field || isImmediateField(field)) return;

    const item = findItem(field.dataset.id);
    if (!item) return;

    if (field.dataset.inlineField === "platform" && !field.value.trim()) {
      updateItemField(item, "platform", "Untitled target");
    }

    if (field.dataset.inlineField === "link") {
      updateItemField(item, "link", field.value.trim());
    }

    flushAutosave();
    render();
  }

  function isImmediateField(field) {
    return field.matches("select") || field.type === "date" || field.type === "time";
  }

  function updateItemField(item, field, value) {
    const nextValue = normalizeFieldValue(field, value);
    if (item[field] === nextValue) return;
    const oldStatus = item.status;
    item[field] = nextValue;
    item.updatedAt = new Date().toISOString();
    
    // A repeating target makes its next occurrence when it leaves the open
    // groups (Planned, In progress) for Done or Closed.
    const isFinalStatus = !Statuses.isOpen(nextValue);
    const wasFinalStatus = !Statuses.isOpen(oldStatus);
    if (field === "status" && isFinalStatus && !wasFinalStatus) {
      handleRepeatingTarget(item);
    }
  }

  function normalizeFieldValue(field, value) {
    const nextValue = String(value ?? "");

    if (field === "category") {
      // An unknown value keeps the current one rather than the first category.
      return Taxonomy.isKnown(nextValue) ? nextValue : "";
    }

    if (field === "campaignId") {
      return state.campaigns.some((campaign) => campaign.id === nextValue) ? nextValue : "";
    }

    if (field === "status") {
      return nextValue ? String(nextValue) : Statuses.defaultStatus();
    }

    if (field === "repeatInterval") {
      const val = parseInt(value, 10);
      return isNaN(val) || val < 0 ? 0 : val;
    }

    if (field === "repeatUnit") {
      return ["days", "weeks", "months"].includes(nextValue) ? nextValue : "";
    }

    if (field === "priority") {
      return ["Very High", "High", "Medium", "Low", "Very Low"].includes(nextValue) ? nextValue : "Medium";
    }

    if (field === "date") {
      return /^\d{4}-\d{2}-\d{2}$/.test(nextValue) ? nextValue : "";
    }

    if (field === "time") {
      return /^\d{2}:\d{2}$/.test(nextValue) ? nextValue : nowDateTimeParts().time;
    }

    return nextValue;
  }

  function deleteItem(item) {
    state.items = state.items.filter((entry) => entry.id !== item.id);
    state.deletedItems.unshift({
      ...item,
      deletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    clampPage();
    persist(t("app.deleteItem.movedToRecycleBin"));
    render();
  }

  function moveProgramToRecycle(program) {
    state.programs = state.programs.filter((entry) => entry.id !== program.id);
    state.deletedPrograms.unshift({
      ...program,
      deletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    persist(t("app.moveProgramToRecycle.programMovedToRecycleBin"));
    render();
  }

  function moveFundingToRecycle(funding) {
    state.funding = state.funding.filter((entry) => entry.id !== funding.id);
    state.deletedFunding.unshift({
      ...funding,
      deletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    persist(t("app.moveFundingToRecycle.fundingRecordMovedToRecycle"));
    render();
  }



  function resetCampaignForm() {
    elements.campaignForm.reset();
    elements.campaignStatusInput.innerHTML = campaignStatusOptions(defaultCampaignStatus());
  }

  function resetTagForm() {
    if (!elements.tagForm) return;
    elements.tagForm.reset();
    // The colour is optional: it counts only once it was picked.
    if (elements.tagColorInput) delete elements.tagColorInput.dataset.touched;
  }

  function resetDailyForm() {
    elements.dailyForm.reset();
    renderDailyFormOptions();
    elements.dailyPriorityInput.value = "Medium";
    elements.dailyActiveInput.checked = true;
    if (elements.dailySharedInput) elements.dailySharedInput.checked = false;
  }

  // The add form's group and priority lists, from data.
  function renderDailyFormOptions() {
    if (elements.dailySubcategoryInput) {
      const current = elements.dailySubcategoryInput.value;
      const ids = Options.list("researchGroups").map((group) => group.id);
      elements.dailySubcategoryInput.innerHTML = Options.optionsHtml("researchGroups", ids.includes(current) ? current : ids[0] || "");
    }
    if (elements.dailyPriorityInput && !elements.dailyPriorityInput.options.length) {
      elements.dailyPriorityInput.innerHTML = dailyPriorities.map((priority) => `<option ${priority === "Medium" ? "selected" : ""}>${escapeHtml(priority)}</option>`).join("");
    }
  }

  function resetFeedbackForm() {
    elements.feedbackForm.reset();
    const first = (list, preferred) => {
      const ids = Options.list(list).map((option) => option.id);
      return ids.includes(preferred) ? preferred : ids[0] || "";
    };
    elements.feedbackTypeInput.value = first("feedbackTypes", "feedback");
    elements.feedbackStatusInput.value = "new";
    if (elements.feedbackSourceInput) elements.feedbackSourceInput.value = first("feedbackSources", "other");
    if (elements.feedbackRelationshipInput) elements.feedbackRelationshipInput.value = first("feedbackRelationships", "none");
    if (elements.feedbackStageInput) elements.feedbackStageInput.value = first("feedbackStages", "unknown");
    if (elements.feedbackAreaInput) elements.feedbackAreaInput.value = first("feedbackAreas", "other");
    if (elements.feedbackEvidenceInput) elements.feedbackEvidenceInput.value = first("feedbackEvidence", "anecdote");
    feedbackAboutPicker().setValue([]);
    if (elements.feedbackBlockFields) {
      elements.feedbackBlockFields.innerHTML = "";
      delete elements.feedbackBlockFields.dataset.block;
    }
    renderFeedbackFormBlock();
  }

  function resetMediaForm() {
    elements.mediaForm.reset();
    elements.mediaSourceInput.value = "upload";
    elements.mediaTypeInput.value = "screenshot";
    updateMediaSourceMode();
    renderMediaControls();
  }

  function deleteCampaign(campaign) {
    const linkedCount = countCampaignItems(campaign.id);
    if (linkedCount) {
      const confirmed = window.confirm(t("recycle.confirmDeleteCampaignLinked", { name: campaign.name, count: linkedCount }));
      if (!confirmed) return;
      state.items.forEach((item) => {
        if (item.campaignId === campaign.id) {
          item.campaignId = "";
          item.updatedAt = new Date().toISOString();
        }
      });
      state.deletedItems.forEach((item) => {
        if (item.campaignId === campaign.id) {
          item.campaignId = "";
          item.updatedAt = new Date().toISOString();
        }
      });
      [state.programs, state.funding, state.deletedPrograms, state.deletedFunding].forEach((records) => {
        records.forEach((record) => {
          if (record.campaignId === campaign.id) {
            record.campaignId = "";
            record.updatedAt = new Date().toISOString();
          }
        });
      });
    } else if (!window.confirm(t("recycle.confirmDeleteCampaign", { name: campaign.name }))) {
      return;
    }

    moveRecordToBin("campaigns", campaign.id);
    if (state.campaignFilter === campaign.id) {
      state.campaignFilter = "all";
    }
    persist(t("recycle.moved"));
    render();
  }

  function deleteDailyLink(link) {
    if (!window.confirm(t("recycle.confirmDeleteLink", { name: link.title || link.url || "" }))) return;
    moveRecordToBin("dailyLinks", link.id);
    persist(t("recycle.moved"));
    renderDailyGroups();
  }

  function deleteAiAccount(account) {
    if (!window.confirm(t("app.deleteAiAccount.deleteAiEntry", { name: account.name }))) return;
    state.aiAccounts = state.aiAccounts.filter((entry) => entry.id !== account.id);
    if (state.editingAiAccountId === account.id) state.editingAiAccountId = null;
    persist(t("app.deleteAiAccount.aiAccessDeleted"));
    renderAiGroups();
  }

  function ensureAiFlowSeparator() {
    if (!state.aiFlow) state.aiFlow = [];
    const hasSeparator = state.aiFlow.some((entry) => entry && entry.isSeparator);
    if (!hasSeparator) {
      state.aiFlow.push({
        id: "ai-flow-separator-occasional",
        isSeparator: true,
        title: "occasional",
      });
    }
  }

  function addAiFlowItem() {
    ensureAiFlowSeparator();
    const newItem = {
      id: `flow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      subApi: "",
      model: "",
      details: "",
    };
    state.aiFlow = [...(state.aiFlow || []), newItem];
    state.editingAiFlowIds.add(newItem.id);
    persist(t("app.addAiFlowItem.currentFlowItemAdded"));
    renderAiFlow();
    setTimeout(() => {
      const input = elements.aiFlowWrap?.querySelector(`input[data-id="${newItem.id}"][data-ai-flow-field="subApi"]`);
      if (input) input.focus();
    }, 0);
  }

  function deleteAiFlowItem(item) {
    if (!item || item.isSeparator) return;
    if (!window.confirm(t("app.deleteAiFlowItem.confirm", { name: item.subApi || t("app.deleteAiFlowItem.item") }))) return;
    state.aiFlow = state.aiFlow.filter((entry) => entry.id !== item.id);
    state.editingAiFlowIds.delete(item.id);
    persist(t("app.deleteAiFlowItem.currentFlowEntryDeleted"));
    renderAiFlow();
  }

  function moveAiFlowItem(id, direction) {
    if (!state.aiFlow || state.aiFlow.length < 2) return;
    const index = state.aiFlow.findIndex((entry) => entry.id === id);
    if (index === -1) return;
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= state.aiFlow.length) return;

    const nextItems = [...state.aiFlow];
    const [moved] = nextItems.splice(index, 1);
    nextItems.splice(targetIndex, 0, moved);
    state.aiFlow = nextItems;
    persist(t("app.moveAiFlowItem.currentFlowReordered"));
    renderAiFlow();
  }

  function reorderAiFlowItem(sourceId, targetId, insertBefore) {
    if (!state.aiFlow || state.aiFlow.length < 2 || sourceId === targetId) return;
    const sourceIndex = state.aiFlow.findIndex((entry) => entry.id === sourceId);
    if (sourceIndex === -1) return;

    const nextItems = [...state.aiFlow];
    const [moved] = nextItems.splice(sourceIndex, 1);

    const targetIndex = nextItems.findIndex((entry) => entry.id === targetId);
    if (targetIndex === -1) return;

    const insertIndex = insertBefore ? targetIndex : targetIndex + 1;
    nextItems.splice(insertIndex, 0, moved);

    state.aiFlow = nextItems;
    persist(t("app.reorderAiFlowItem.currentFlowReordered"));
    renderAiFlow();
  }

  function toggleEditAllAiFlow() {
    if (state.isEditingAllAiFlow) {
      state.isEditingAllAiFlow = false;
      state.editingAiFlowIds.clear();
      persist(t("app.toggleEditAllAiFlow.currentFlowUpdated"));
      renderAiFlow();
    } else {
      state.isEditingAllAiFlow = true;
      renderAiFlow();
    }
  }

  function deleteFeedbackItem(item) {
    if (!window.confirm(t("recycle.confirmDeleteFeedback", { name: item.title || "" }))) return;
    moveRecordToBin("feedbackItems", item.id);
    persist(t("recycle.moved"));
    renderFeedbackList();
  }

  function deleteMediaItem(media) {
    if (!window.confirm(t("recycle.confirmDeleteMedia", { name: media.title || "" }))) return;
    moveRecordToBin("mediaItems", media.id);
    persist(t("recycle.moved"));
    renderMediaControls();
    renderMediaList();
  }

  // Deleting a tag takes it off every record in every startup and moves its
  // definition to the recycle bin (lib/tags.js).
  function deleteTagDefinition(tagId) {
    const tag = tagDefinitions.find((def) => def.id === tagId) || { id: tagId, label: tagId };
    const usage = tagUsageOf(tagId);
    const message = usage.total
      ? t("extra.tags.confirmDeleteUsed", { name: tag.label || tag.id, count: usage.total, startups: usage.startups.length })
      : t("recycle.confirmDeleteTag", { name: tag.label || tag.id });
    if (!window.confirm(message)) return;
    if (state.editingTagId === tagId) state.editingTagId = null;
    runTagAction("delete", { tag: tagId }, t("extra.tags.deleted", { name: tag.label || tag.id }));
  }

  // ---- Tags across startups -----------------------------------------------------

  // Usage of every tag in every startup, read when the Tags page opens and
  // after each rename, merge or delete.
  let tagUsageCache = null;

  async function loadTagUsage() {
    if (tagUsageCache?.loading) return;
    tagUsageCache = { loading: true, usage: tagUsageCache?.usage || {} };
    try {
      const response = await fetch(Api.urls.tagUsage, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
      tagUsageCache = { loading: false, usage: body.usage || {} };
    } catch {
      tagUsageCache = { loading: false, usage: tagUsageCache.usage, failed: true };
    }
    if (state.selectedAppTab === "extra" && state.selectedExtraSubTab === "tags") renderTags();
  }

  function tagUsageOf(tagId) {
    const entry = tagUsageCache?.usage?.[tagId];
    if (!entry) return { total: 0, startups: [] };
    const startups = Object.entries(entry.startups || {})
      .filter(([, bucket]) => bucket.count > 0)
      .map(([id, bucket]) => ({ id, name: bucket.name || t("extra.tags.sharedRecords"), count: bucket.count }));
    return { total: entry.total || 0, startups };
  }

  // Rename, merge and delete change records in every startup on the server,
  // so this page saves its own edits first and reads everything again after.
  async function runTagAction(action, payload, doneMessage) {
    const saved = await persist(t("app.runTagAction.saved"));
    if (!saved || hasSendableOutboxBatch() || hasBlockedConflictBatch()) {
      window.alert(t("extra.tags.saveFirst"));
      return false;
    }
    await globalChannel?.flush();
    try {
      const response = await fetch(Api.urls.tagAction(action), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, origin: "ui" }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
      if (action !== "delete") state.editingTagId = body.tag || null;
    } catch (error) {
      window.alert(t("extra.tags.failed", { message: error.message }));
      return false;
    }
    tagUsageCache = null;
    await loadStateFromServer({ forceSnapshot: true });
    await refreshGlobalData();
    markSaved(doneMessage);
    render();
    return true;
  }

  // ---- Recycle bin ----------------------------------------------------------
  // Deleting moves a record to its paired bin section with deletedAt (the
  // pairs are in js/recycle.js); restoring moves it back. Every change is a
  // normal edit, saved through the outbox.

  function moveRecordToBin(liveSection, id) {
    const kind = Recycle.kindOfLive(liveSection);
    if (!kind) return null;
    const result = Recycle.moveToBin(getLiveCollection(liveSection), state[kind.deleted], id);
    if (!result.moved) return null;
    setLiveSection(liveSection, result.live);
    state[kind.deleted] = result.deleted;
    markDataChanged();
    return result.moved;
  }

  function getRecycleBin() {
    return Recycle.groupBin((section) => state[section]);
  }

  function restoreFromBin(section, id) {
    const kind = Recycle.kindOfDeleted(section);
    if (!kind) return false;
    const result = Recycle.restoreFromBin(getLiveCollection(kind.live), state[section], id);
    if (!result.restored) return false;
    setLiveSection(kind.live, result.live);
    state[section] = result.deleted;
    markDataChanged();
    persist(t("recycle.restored"));
    render();
    return true;
  }

  function deleteFromBin(section, id) {
    if (!Recycle.kindOfDeleted(section)) return false;
    const before = Array.isArray(state[section]) ? state[section].length : 0;
    const files = section === "deletedMediaItems" ? uploadedFileNames(state[section].filter((record) => String(record.id) === String(id))) : [];
    state[section] = Recycle.removeFromBin(state[section], id);
    if (state[section].length === before) return false;
    dropLinksTo([{ kind: Links.kindOfSection(section), id: String(id) }]);
    markDataChanged();
    persist(t("recycle.deletedForever")).then((saved) => removeMediaFiles(saved, files));
    render();
    return true;
  }

  // A media file stays while its record is in the bin, and goes once the
  // record is deleted for good and saved; the server keeps it if anything else
  // in the startup still names it.
  function uploadedFileNames(records) {
    return records.filter((record) => record?.sourceType === "upload").map((record) => record.storedName || String(record.filePath || "").split("/").pop()).filter(Boolean);
  }

  async function removeMediaFiles(saved, files) {
    if (!saved || !files.length) return;
    try {
      await fetch(Api.api("/media/remove-files"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: files.map((name) => { try { return decodeURIComponent(name); } catch { return name; } }) }),
      });
    } catch {
      // A file left behind shows in tools/media-orphans.js.
    }
  }

  // Records deleted for good take their links with them.
  function dropLinksTo(refs) {
    const keys = new Set(refs.filter((ref) => ref.kind).map((ref) => `${ref.kind}:${ref.id}`));
    if (!keys.size) return;
    state.links = state.links.filter((link) => !keys.has(`${link.a.kind}:${link.a.id}`) && !keys.has(`${link.b.kind}:${link.b.id}`));
  }

  function emptyBin() {
    if (Recycle.countBin((section) => state[section]) === 0) return false;
    const files = uploadedFileNames(state.deletedMediaItems || []);
    const gone = [];
    Recycle.DELETED_SECTIONS.forEach((section) => {
      const kind = Links.kindOfSection(section);
      if (kind) (state[section] || []).forEach((record) => gone.push({ kind, id: String(record.id) }));
      state[section] = [];
    });
    dropLinksTo(gone);
    markDataChanged();
    persist(t("recycle.emptied")).then((saved) => removeMediaFiles(saved, files));
    render();
    return true;
  }

  // ---- Startup profile ------------------------------------------------------

  function getProfile() {
    return state.profile ? clonePersistedState(state.profile) : {};
  }

  // Settings hands over the whole profile; it is stored as one section.
  function saveProfile(profile) {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new TypeError("A profile is an object.");
    state.profile = clonePersistedState(profile);
    markDataChanged();
    persist(t("settings.saved"));
  }

  function toggleMediaPin(media) {
    media.pinned = !media.pinned;
    media.updatedAt = new Date().toISOString();
    persist(media.pinned ? t("app.toggleMediaPin.mediaPinned") : t("app.toggleMediaPin.mediaUnpinned"));
    renderMediaList();
  }

  // Shows a Marketing target in its list, and opens its window when asked.
  function openTargetForEditing(id, { openNotes = false, initialTab = "overview" } = {}) {
    const item = findItem(id);
    if (!item) return;
    navigateToTarget(item.id);
    if (openNotes) openNotesModal(item, initialTab);
  }

  function flashElement(selector) {
    window.setTimeout(() => {
      const element = document.querySelector(selector);
      if (!element) return;
      element.scrollIntoView({ behavior: "smooth", block: "center" });
      element.classList.add("highlight-flash");
      window.setTimeout(() => {
        element.classList.remove("highlight-flash");
      }, 2500);
    }, 0);
  }

  function navigateToCampaign(campaignId) {
    const campaign = findCampaign(campaignId);
    if (!campaign) return;

    if (!RecordWindow.requestClose()) return;
    state.selectedAppTab = "extra";
    state.selectedExtraSubTab = "campaigns";
    state.campaignSearch = "";
    state.campaignStatusFilter = [];
    state.campaignTagFilter = [];
    state.editingCampaignId = null;
    if (elements.campaignSearchInput) elements.campaignSearchInput.value = "";

    const campaigns = state.campaigns
      .slice()
      .sort((a, b) => campaignStatusWeight(a.status) - campaignStatusWeight(b.status) || String(a.startDate || "").localeCompare(String(b.startDate || "")) || a.name.localeCompare(b.name));
    const index = campaigns.findIndex((entry) => entry.id === campaign.id);
    state.campaignPage = index >= 0 ? Math.floor(index / MANAGER_PAGE_SIZE) + 1 : 1;

    render();
    flashElement(`[data-campaign-id="${cssEscape(campaign.id)}"]`);
  }

  function navigateToFeedback(feedbackId, { edit = false } = {}) {
    const item = findFeedbackItem(feedbackId);
    if (!item) return;

    if (!RecordWindow.requestClose()) return;
    state.selectedAppTab = "extra";
    state.selectedExtraSubTab = "feedback";
    state.feedbackTypeFilter = "all";
    state.feedbackStageFilter = "all";
    state.feedbackEvidenceFilter = "all";
    state.feedbackTagFilter = [];
    state.editingFeedbackItemId = edit ? item.id : null;

    const feedbackItems = state.feedbackItems
      .slice()
      .sort((a, b) => feedbackStatusWeight(a.status) - feedbackStatusWeight(b.status) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const index = feedbackItems.findIndex((entry) => entry.id === item.id);
    state.feedbackPage = index >= 0 ? Math.floor(index / MANAGER_PAGE_SIZE) + 1 : 1;

    render();
    flashElement(`[data-feedback-id="${cssEscape(item.id)}"]`);
  }

  function openMediaForEditing(id) {
    const media = findMediaItem(id);
    if (!media) return;
    state.selectedAppTab = "extra";
    state.selectedExtraSubTab = "media";
    state.editingMediaItemId = media.id;
    state.mediaSearch = "";
    state.mediaTypeFilter = "all";
    state.mediaSourceFilter = "all";
    state.mediaTargetFilter = "all";
    state.mediaKindFilter = "all";
    state.mediaTagFilter = "all";
    const mediaItems = getFilteredMediaItems();
    const index = mediaItems.findIndex((item) => item.id === media.id);
    state.mediaPage = index >= 0 ? Math.floor(index / MANAGER_PAGE_SIZE) + 1 : 1;
    if (elements.mediaSearchInput) elements.mediaSearchInput.value = "";
    if (elements.mediaTypeFilter) elements.mediaTypeFilter.value = "all";
    if (elements.mediaSourceFilter) elements.mediaSourceFilter.value = "all";
    if (elements.mediaTargetFilter) elements.mediaTargetFilter.value = "all";
    render();
    window.setTimeout(() => {
      const card = document.querySelector(`[data-media-id="${cssEscape(media.id)}"]`);
      if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 0);
  }

  function openUrlInTab(url) {
    if (!url) return false;
    try {
      const win = window.open(url, "_blank");
      if (win && !win.closed && typeof win.closed !== "undefined") {
        return true;
      }
    } catch {
      // Ignore
    }
    return false;
  }

  function openDailyLink(link) {
    const hrefs = getDailyLinkUrls(link.url);
    if (!hrefs.length) return;
    let openedCount = 0;
    hrefs.forEach((href) => {
      if (openUrlInTab(href)) {
        openedCount++;
      }
    });
    link.lastOpenedAt = new Date().toISOString();
    link.updatedAt = new Date().toISOString();
    persist(t("app.openDailyLink.linkOpened"));
    renderDailyGroups();
    if (hrefs.length > 1 && openedCount < hrefs.length) {
      markSaved(t("app.openDailyLink.openedLinksBrowserBlockedPop", { openedCount, length: hrefs.length }));
      setTimeout(() => {
        alert(
          `Opened ${openedCount} of ${hrefs.length} links.\n\n` +
            `Your browser blocked ${hrefs.length - openedCount} tab(s).\n\n` +
            `To open all ${hrefs.length} links with 1 click:\n` +
            `1. Click the "Pop-ups blocked" icon (🔒 or 🗔) in your browser address bar.\n` +
            `2. Select "Always allow pop-ups and redirects".\n` +
            t("app.openDailyLink.3ClickDoneAndTry"),
        );
      }, 150);
    } else if (hrefs.length > 1) {
      markSaved(t("app.openDailyLink.openedAllLinks", { length: hrefs.length }));
    }
  }

  function openDailyGroup(subcategory) {
    const links = state.dailyLinks
      .filter((link) => link.subcategory === subcategory && link.active)
      .map((link) => ({ link, hrefs: getDailyLinkUrls(link.url) }))
      .filter(({ hrefs }) => hrefs.length);
    if (!links.length) return;

    const openedAt = new Date().toISOString();
    let totalCount = 0;
    let openedCount = 0;
    links.forEach(({ link, hrefs }) => {
      hrefs.forEach((href) => {
        totalCount++;
        if (openUrlInTab(href)) {
          openedCount++;
        }
      });
      link.lastOpenedAt = openedAt;
      link.updatedAt = openedAt;
    });
    persist(t("app.openDailyGroup.researchLinksOpened"));
    renderDailyGroups();
    if (totalCount > 1 && openedCount < totalCount) {
      markSaved(t("app.openDailyGroup.openedLinksBrowserBlockedPop", { openedCount, totalCount }));
      setTimeout(() => {
        alert(
          `Opened ${openedCount} of ${totalCount} links.\n\n` +
            `Your browser blocked ${totalCount - openedCount} tab(s).\n\n` +
            `To open all ${totalCount} links with 1 click:\n` +
            `1. Click the "Pop-ups blocked" icon (🔒 or 🗔) in your browser address bar.\n` +
            `2. Select "Always allow pop-ups and redirects".\n` +
            t("app.openDailyGroup.3ClickDoneAndTry"),
        );
      }, 150);
    } else if (totalCount > 1) {
      markSaved(t("app.openDailyGroup.openedAllLinks", { totalCount }));
    }
  }

  // Paints the light or dark theme and updates the toggle. Remembering the
  // choice is the appearance module's job (scripts/taste-switcher.js).
  function updateTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);

    if (theme === "dark") {
      elements.themeToggleButton.innerHTML = `
        <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round" class="theme-icon-sun"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>
      `;
      elements.themeToggleButton.setAttribute("data-tooltip", t("app.updateTheme.switchToLightTheme"));
    } else {
      elements.themeToggleButton.innerHTML = `
        <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round" class="theme-icon-moon"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
      `;
      elements.themeToggleButton.setAttribute("data-tooltip", t("app.updateTheme.switchToDarkTheme"));
    }

  }

  // The top bar's button picks light or dark explicitly and saves it as the
  // shared appearance (Settings > Appearance shows the same choice).
  function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute("data-theme") || "light";
    const nextTheme = currentTheme === "dark" ? "light" : "dark";
    const appearance = Appearance.apply({ ...Appearance.get(), mode: nextTheme });
    updateTheme(nextTheme);
    Settings.save({ appearance: { mode: appearance.mode, theme: appearance.theme } }).catch(() => {
      markSaved(t("settings.saveFailed", { error: t("sync.offline") }));
    });
  }

  function clampPage() {
    const totalPages = Math.max(1, Math.ceil(getFilteredItems().length / state.pageSize));
    state.currentPage = Math.min(Math.max(1, state.currentPage), totalPages);
  }

  function renderMarkdown(text) {
    if (!text || !text.trim()) return "";
    const rendererKey = typeof marked !== "undefined" && marked.parse ? "marked" : "plain";
    const cacheKey = `${rendererKey}\u0000${text}`;
    if (markdownCache.has(cacheKey)) return markdownCache.get(cacheKey);

    try {
      let html = "";
      if (rendererKey === "marked") {
        html = marked.parse(text, { breaks: true, gfm: true });
      } else {
        html = escapeHtml(text);
      }
      const rendered = sanitizeRenderedHtml(html);
      if (markdownCache.size >= 2048) markdownCache.clear();
      markdownCache.set(cacheKey, rendered);
      return rendered;
    } catch {
      return escapeHtml(text);
    }
  }

  function markdownToPlainText(text) {
    const container = document.createElement("div");
    container.innerHTML = renderMarkdown(text);
    return String(container.innerText || container.textContent || "").trim();
  }

  function cloneComparableValue(value) {
    if (value === undefined) return null;
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeComparableValue(value) {
    if (Array.isArray(value)) {
      return value.map((entry) => normalizeComparableValue(entry));
    }
    if (value && typeof value === "object") {
      return Object.keys(value).sort().reduce((normalized, key) => {
        normalized[key] = normalizeComparableValue(value[key]);
        return normalized;
      }, {});
    }
    return value;
  }

  function confirmDiscardModalChanges() {
    return window.confirm(t("app.confirmDiscardModalChanges.discardUnsavedChangesAllProgress"));
  }

  // ---- The target window (js/record-window.js) ------------------------------
  //
  // One window for MK, PO and FU targets, drawn from the field registry
  // (js/fields.js). The page hands it what only the page knows (lists,
  // pickers, links, history) and stores what it saves through the outbox.

  const RecordWindow = window.StartupTrackerRecordWindow;
  const WINDOW_SECTIONS = {
    mk: { collection: "items", tab: "pipeline", normalize: (record) => normalizeItem(record) },
    po: { collection: "programs", tab: "programs", normalize: (record) => normalizeProgram(record) },
    fu: { collection: "funding", tab: "funding", normalize: (record) => normalizeFundingSource(record) },
  };
  // Tab names the older windows had, which other code and saved links still pass.
  const OLD_WINDOW_TABS = { preview: "overview", metadata: "details", core: "details", extra: "extras", commitments: "details", payments: "details", eligibility: "details", valuecosts: "details", tracking: "details" };
  const RECORD_WINDOW_HISTORY_PANE = "recordWindowPane-history";
  // "Create a linked target": the record the new one links back to.
  let pendingLinkFromWindow = null;

  function openTargetWindow(section, id, tab = "overview") {
    const record = (state[WINDOW_SECTIONS[section].collection] || []).find((entry) => entry.id === id);
    if (!record) return false;
    return RecordWindow.open({ section, record, tab: OLD_WINDOW_TABS[tab] || tab });
  }

  function openNotesModal(item, tab) {
    return item ? openTargetWindow("mk", item.id, tab) : false;
  }

  function openProgramModal(id, tab) {
    return openTargetWindow("po", id, tab);
  }

  function openFundingModal(id, tab) {
    return openTargetWindow("fu", id, tab);
  }

  function saveTargetFromWindow({ section, record, draft, original }) {
    const config = WINDOW_SECTIONS[section];
    const list = state[config.collection];
    const now = new Date().toISOString();
    const next = config.normalize({ ...record, updatedAt: now, ...(draft ? { createdAt: now } : {}) });
    if (!next) return null;
    if (draft) {
      list.unshift(next);
      if (pendingLinkFromWindow) {
        state.links = Links.mergeLinks(state.links, [Links.makeLink(pendingLinkFromWindow, { kind: section, id: next.id })]);
        pendingLinkFromWindow = null;
      }
      finishAddForm(section);
    } else {
      const index = list.findIndex((entry) => entry.id === next.id);
      if (index < 0) return null;
      list[index] = next;
      // A repeating target makes its next occurrence when it leaves the open
      // groups (Planned, In progress) for Done or Closed.
      if (section === "mk" && Statuses.isOpen(original.status) && !Statuses.isOpen(next.status)) handleRepeatingTarget(next);
    }
    markDataChanged();
    persist(draft ? t("app.saveTargetFromWindow.targetAdded") : t("app.saveTargetFromWindow.targetUpdated"));
    render();
    return next;
  }

  function removeTargetFromWindow({ section, record }) {
    const name = RecordWindow.nameOf(section, record) || t("app.removeTargetFromWindow.thisTarget");
    if (!window.confirm(t("app.removeTargetFromWindow.moveToTheRecycleBin", { name }))) return false;
    if (section === "mk") {
      const item = findItem(record.id);
      if (item) deleteItem(item);
    } else if (section === "po") {
      const program = state.programs.find((entry) => entry.id === record.id);
      if (program) moveProgramToRecycle(program);
    } else {
      const funding = state.funding.find((entry) => entry.id === record.id);
      if (funding) moveFundingToRecycle(funding);
    }
    return true;
  }

  function showTargetInList(section, id) {
    if (section === "mk") {
      navigateToTarget(id);
      return;
    }
    state.selectedAppTab = WINDOW_SECTIONS[section].tab;
    for (const key of TAXONOMY_VIEWS[section].keys) state[key] = "all";
    render();
    sectionPages[section]?.showRecord(id);
  }

  function formatWindowDateTime(value) {
    const text = String(value || "");
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) return `${formatDate(text.slice(0, 10))} ${text.slice(11)}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return formatDate(text);
    return formatTimestamp(text);
  }

  function configureRecordWindow() {
    RecordWindow.configure({
      newId: makeId,
      formatDate,
      formatDateTime: formatWindowDateTime,
      formatNumber,
      statusLabel: (id) => Statuses.label(id),
      statusBadgeHtml,
      statusOptionsHtml: (value) => renderStatusOptions(value),
      campaignOptions: () => state.campaigns.map((campaign) => ({ id: campaign.id, name: campaign.name })),
      campaignName: (id) => state.campaigns.find((campaign) => campaign.id === id)?.name || id,
      roundOptions: () => state.fundingRounds.map((round) => ({ id: round.id, name: round.name })),
      roundName: (id) => state.fundingRounds.find((round) => round.id === id)?.name || id,
      taxonomyLabel: (list) => Taxonomy.leaves(list).map((id) => Taxonomy.pathLabel(id)).join("; "),
      mountTaxonomyPicker: (holder, section, value, onChange) => window.StartupTrackerTaxonomyPicker?.create(holder, { section, value, onChange, label: t("taxonomy.fieldLabel") }),
      applyTaxonomy: (record, list, section) => applyTaxonomy(record, list, { subcategories: section === "mk" }),
      renderMarkdown,
      normalizeTags: (text) => normalizeTagArray(String(text || "").split(",")),
      suggestion: (field) => (field?.suggested === "profile.currency" ? String(state.profile?.currency || "") : ""),
      renderLinks: (container, section, id) => renderLinksPanel(container, section, id),
      linkedSummary: (section, id) => visibleLinksOf(section, id).map((entry) => `${entry.label}: ${describeRecord(entry.other)?.title || entry.other.id}`),
      createLinked: ({ section, from }) => {
        const link = { kind: from.section, id: String(from.record.id) };
        if (RecordWindow.open({ section, draft: { campaignId: from.record.campaignId || "" }, tab: "details" })) pendingLinkFromWindow = link;
      },
      renderHistory: () => activateRecordHistoryPane(RECORD_WINDOW_HISTORY_PANE),
      save: saveTargetFromWindow,
      remove: removeTargetFromWindow,
      showInList: showTargetInList,
      onClose: () => {
        pendingLinkFromWindow = null;
      },
    });
  }

  // ---- The section pages (js/section-page.js) --------------------------------
  //
  // Marketing, Programs and Funding share one page: header metrics, the Focus
  // queue, the Add target form and the read-only Targets table. The page asks
  // here what each target looks like, as one shape for every section.

  const SectionPage = window.StartupTrackerSectionPage;
  const SECTION_PAGES = {
    mk: { view: "pipelineView", tab: "pipeline", picker: "mkForm", valueLabel: "" },
    po: { view: "programsView", tab: "programs", picker: "poForm", get valueLabel() { return t("app.sectionPages.cashOnOffer"); } },
    fu: { view: "fundingView", tab: "funding", picker: "fuForm", get valueLabel() { return t("app.sectionPages.ask"); } },
  };
  const sectionPages = {};
  const sectionFieldCache = {};

  // The field definitions a row reads, found once per section.
  function sectionFields(section) {
    if (!sectionFieldCache[section]) {
      const pick = (key) => Fields.findField(section, key);
      sectionFieldCache[section] = {
        name: pick("name"),
        organization: pick("organization"),
        link: pick("link"),
        nextActionDate: pick("nextActionDate"),
        nextActionTime: pick("nextActionTime"),
        nextAction: pick("nextAction"),
        owner: pick("owner"),
        value: section === "fu" ? pick("askAmount") : section === "po" ? pick("cashValue") : null,
      };
    }
    return sectionFieldCache[section];
  }

  function describeTarget(section, record) {
    const fields = sectionFields(section);
    const read = (field) => (field ? Fields.getValue(section, record, field) : "");
    const leaves = Taxonomy.leaves(record.taxonomy || []);
    const categoryPath = leaves.length ? Taxonomy.pathLabel(leaves[0]) : "";
    const status = record.status;
    const value = fields.value ? read(fields.value) : null;
    const valueAmount = value ? (value.amount ?? value.max ?? value.min ?? null) : null;
    const name = read(fields.name);
    const organization = read(fields.organization);
    const campaignName = record.campaignId ? getCampaignName(record.campaignId) : "";
    const custom = Object.values(record.custom || {}).map((entry) => (Array.isArray(entry) ? entry.join(" ") : typeof entry === "object" && entry ? Object.values(entry).join(" ") : entry));
    return {
      id: record.id,
      name,
      organization,
      link: safeLink(read(fields.link)),
      categoryPath,
      categoryCount: leaves.length,
      // A category the library does not know, or one this startup turned off.
      categoryFlag: leaves.length && !Taxonomy.isKnown(leaves[0]) ? t("taxonomy.unknown") : leaves.length && !Taxonomy.isEnabled(leaves[0]) ? t("taxonomy.disabled") : "",
      status,
      statusKey: Statuses.isKnown(status) ? status : Statuses.UNMAPPED,
      statusGroup: Statuses.groupOf(status),
      statusRank: Statuses.rank(status),
      open: Statuses.isOpen(status),
      waiting: Statuses.isWaiting(status),
      priority: record.priority,
      nextActionDate: read(fields.nextActionDate),
      nextActionTime: read(fields.nextActionTime),
      nextAction: read(fields.nextAction),
      campaignId: record.campaignId || "",
      campaignName,
      owner: read(fields.owner),
      tags: record.tags || [],
      value: valueAmount === null ? null : { text: Fields.formatValue(fields.value, value, { formatNumber }), sort: Number(valueAmount) || 0 },
      search: [record.id, name, organization, read(fields.link), record.notes, read(fields.nextAction), read(fields.owner), categoryPath, campaignName, (record.tags || []).join(" "), linkedText(section, record.id), ...custom].join(" "),
    };
  }

  // Header numbers: targets per status group, due soon, and the money a
  // section tracks (FU asks, commitments and payments; PO cash on offer).
  function sectionMetrics(section, records) {
    const groups = Statuses.countByGroup(records);
    const today = todayDate();
    const weekEnd = Dates.addDays(today, 7);
    const dueSoon = records.filter((record) => {
      const date = describeTarget(section, record).nextActionDate;
      return Statuses.isOpen(record.status) && date && date >= today && date <= weekEnd;
    }).length;
    const metrics = [
      { label: t("ui.common.targets"), value: String(records.length) },
      ...Statuses.groups().map((group) => ({ label: group.label, value: String(groups.get?.(group.id) ?? groups[group.id] ?? 0), help: group.description })),
      { label: t("app.sectionMetrics.dueIn7Days"), value: String(dueSoon) },
    ];
    if (section === "fu") {
      const open = records.filter((record) => Statuses.isOpen(record.status));
      metrics.push(
        { label: t("app.sectionMetrics.pipeline"), value: summarizeMoney(open.map((funding) => ({ amount: funding.askAmount, currency: funding.askCurrency }))).display, help: t("app.sectionMetrics.whatTheOpenDealsAsk") },
        { label: t("app.sectionMetrics.committed"), value: summarizeMoney(records.flatMap((funding) => funding.commitments || [])).display },
        { label: t("app.sectionMetrics.received"), value: summarizeMoney(records.flatMap((funding) => funding.payments || []), (payment) => payment.status === "Received" || payment.status === "Partially Received").display },
      );
    } else if (section === "po") {
      const cashField = sectionFields("po").value;
      const expected = records
        .filter((program) => Statuses.isOpen(program.status) && program.recordKind !== "watchlist")
        .map((program) => {
          const cash = Fields.getValue("po", program, cashField);
          const amount = cash.max ?? cash.min;
          if (amount === null || amount === undefined) return null;
          const probability = program.details?.probabilityPercent;
          return { amount: probability === null || probability === undefined ? amount : amount * probability / 100, currency: cash.currency || state.profile?.currency || "EUR" };
        })
        .filter(Boolean);
      metrics.push({ label: t("app.sectionMetrics.expectedValue"), value: summarizeMoney(expected).display, help: t("app.sectionMetrics.cashOnOfferInOpen") });
    }
    return metrics;
  }

  function sectionUiKey(section) {
    return Api.storageKey(`section-page-${section}`);
  }

  function addTargetFromPage(section, values, { openDetails = false } = {}) {
    const record = { id: makeId() };
    for (const key of ["name", "organization", "link", "status", "priority", "nextAction", "nextActionDate", "nextActionTime", "campaignId", "tags"]) {
      const field = Fields.findField(section, key);
      if (field && values[key] !== undefined && values[key] !== "") Fields.setValue(section, record, field, values[key]);
    }
    if (values.taxonomy?.length) applyTaxonomy(record, values.taxonomy, { subcategories: section === "mk" });
    if (openDetails) {
      RecordWindow.open({ section, draft: record, tab: "details" });
      return false;
    }
    const now = new Date().toISOString();
    const next = WINDOW_SECTIONS[section].normalize({ ...record, createdAt: now, updatedAt: now });
    if (!next) return false;
    state[WINDOW_SECTIONS[section].collection].unshift(next);
    markDataChanged();
    persist(t("app.addTargetFromPage.targetAdded"));
    render();
    return true;
  }

  function initSectionPages() {
    for (const [section, config] of Object.entries(SECTION_PAGES)) {
      const page = document.getElementById(config.view);
      if (!page) continue;
      sectionPages[section] = SectionPage.create(page, {
        valueLabel: config.valueLabel,
        defaultPageSize: () => Settings.get().pageSize,
        records: () => state[WINDOW_SECTIONS[section].collection],
        describe: (record) => describeTarget(section, record),
        today: todayDate,
        statusHtml: statusBadgeHtml,
        statusOptionsHtml: (selected) => renderStatusOptions(selected),
        defaultStatus: () => Statuses.defaultStatus(),
        formatDate,
        campaigns: () => state.campaigns.map((campaign) => ({ id: campaign.id, name: campaign.name })),
        metrics: (records) => sectionMetrics(section, records),
        matchesTabs: (record) => matchesTaxonomyTabs(section, record),
        customFields: () => Fields.customFields(section),
        customValue: (record, key) => {
          const value = record.custom?.[key];
          return Array.isArray(value) ? value.join(", ") : value && typeof value === "object" ? Object.values(value).join(" ") : value;
        },
        open: (id) => openTargetWindow(section, id),
        add: (values, options) => addTargetFromPage(section, values, options),
        taxonomyValue: () => pickerValue(config.picker),
        resetTaxonomy: () => setPickerValue(config.picker, []),
        statusFilter: StatusFilter,
        statusSelection: {
          defaults: () => Statuses.defaultSelection(),
          all: () => Statuses.allSelection(),
          matches: (selection, status) => Statuses.matches(selection, status),
          restore: (list) => Statuses.restoreSelection(list),
        },
        loadUi: () => {
          try {
            return JSON.parse(window.localStorage.getItem(sectionUiKey(section)) || "null") || {};
          } catch {
            return {};
          }
        },
        saveUi: (ui) => {
          try {
            window.localStorage.setItem(sectionUiKey(section), JSON.stringify(ui));
          } catch {
            // Remembering filters is a convenience only.
          }
        },
      });
    }
  }

  function renderSectionPage(section) {
    renderTaxonomyTabs(section);
    sectionPages[section]?.render();
  }

  // After a target added from its draft window, the add form starts empty.
  function finishAddForm(section) {
    sectionPages[section]?.resetForm();
  }

  // ---------------------------------------------------------------------------
  // Record history
  //
  // A dated timeline of how one MK item, PO program or FU deal changed, read
  // from /api/state/history the first time the History tab is opened.
  //
  // Everything rendered into a history pane is a <button>.
  // ---------------------------------------------------------------------------

  const HISTORY_ORIGIN_LABELS = {
    get ui() { return t("app.historyOriginLabels.you"); },
    api: "API",
    get tool() { return t("app.historyOriginLabels.maintenanceTool"); },
    get backfill() { return t("app.historyOriginLabels.reconstructed"); },
    get restore() { return t("app.historyOriginLabels.restore"); },
    get import() { return t("app.historyOriginLabels.import"); },
  };

  // Sized in em so it matches whatever font size the row it sits in uses.
  const HISTORY_REFRESH_ICON = `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none"`
    + ` stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"`
    + ` aria-hidden="true"><path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"></path>`
    + `<polyline points="20.5 3.5 20.5 9.5 14.5 9.5"></polyline></svg>`;

  // Deleting in this app moves a record into a parallel section instead of
  // removing it, so a delete and a create at the same moment are one move. The
  // server merges both halves into a single timeline; the module below is what
  // recognises the pair once it arrives, and it also rebuilds each past version
  // of the record from the stored deltas.
  const historyTimeline = globalThis.RecordHistoryTimeline;

  const isPlainHistoryObject = (value) => historyTimeline.isPlainObject(value);
  const isTruncatedHistoryValue = (value) => historyTimeline.isTruncatedValue(value);
  const resolveHistoryPath = (root, path, create) => historyTimeline.resolvePath(root, path, create);
  const splitHistoryPath = (root, path) => historyTimeline.splitPath(root, path);
  const describeHistoryChanges = (before, after) => historyTimeline.describeChanges(before, after);

  // Fields holding prose, which read better as a line diff even when short.
  const HISTORY_TEXT_FIELDS = new Set([
    "notes", "description", "summary", "outcome", "blocker", "nextAction",
    "previousAction", "requirements", "eligibility",
  ]);
  const HISTORY_TEXT_DIFF_MIN_LENGTH = 120;
  const HISTORY_DIFF_CONTEXT_LINES = 3;
  const HISTORY_READ_LIMIT = 500;
  // How many lines one press of a context control uncovers at either end of a
  // hidden run.
  const HISTORY_GAP_STEP = 5;

  // The target window's History tab. Its record is whichever target the
  // window has open; every section's update log joins the timeline, styled
  // apart from the automatic field changes.
  const HISTORY_PANES = {
    "recordWindowPane-history": {
      get section() {
        const open = RecordWindow.state();
        return open ? WINDOW_SECTIONS[open.section].collection : "";
      },
      getRecordId: () => {
        const open = RecordWindow.state();
        return open && !open.draft ? open.id : "";
      },
      findRecord: (id) => {
        const open = RecordWindow.state();
        return open ? (state[WINDOW_SECTIONS[open.section].collection] || []).find((record) => record.id === id) || null : null;
      },
      // A value restored from History is already saved; the window shows the
      // record again from the start.
      reopen: (id) => {
        const open = RecordWindow.state();
        const record = open ? (state[WINDOW_SECTIONS[open.section].collection] || []).find((entry) => entry.id === id) : null;
        if (!record) return;
        RecordWindow.refresh(record);
        RecordWindow.selectTab("history");
      },
      activityLog: true,
    },
  };

  const historyPaneStates = new Map();
  // The preview and restore dialogs open over a detail modal, so they hand focus
  // back to the button that opened them rather than to the modal's own default.
  let historyDialogReturnFocus = null;
  let historyRestoreRequest = null;

  // The deep comparison the conflict review already uses, so "the record already
  // holds this value" means the same thing in both places.
  const historyValuesEqual = (a, b) => globalThis.RecordConflictMerge.valuesEqual(a, b);

  function getHistoryPaneState(paneId) {
    let paneState = historyPaneStates.get(paneId);
    if (!paneState) {
      paneState = {
        recordId: "",
        status: "idle",
        error: "",
        message: "",
        entries: [],
        total: 0,
        available: true,
        loadToken: 0,
        timeline: [],
        // The pane rebuilds its whole innerHTML on every click, so a native
        // <details> open state would be lost each time. What is unfolded lives
        // here instead: entries start closed and days start open, which is why
        // one Set holds what is open and the other what is closed.
        expandedEntries: new Set(),
        collapsedDays: new Set(),
        // fieldKey::gapN -> { head, tail }: how many of a hidden run's lines are
        // uncovered from its top and from its bottom.
        gapReveals: new Map(),
        wrapFields: new Set(),
        previewable: new Map(),
        // Line counts for the collapsed digest. Diffing every text field on
        // every re-render would mean re-running the LCS for the whole timeline
        // each time a caret is clicked.
        diffStats: new Map(),
        compare: [],
        restorable: new Map(),
      };
      historyPaneStates.set(paneId, paneState);
    }
    return paneState;
  }

  function resetHistoryPaneState(paneState, recordId) {
    paneState.recordId = recordId;
    paneState.status = "idle";
    paneState.error = "";
    paneState.message = "";
    paneState.entries = [];
    paneState.total = 0;
    paneState.available = true;
    paneState.timeline = [];
    paneState.expandedEntries.clear();
    paneState.collapsedDays.clear();
    paneState.gapReveals.clear();
    paneState.wrapFields.clear();
    paneState.previewable.clear();
    paneState.diffStats.clear();
    paneState.compare = [];
    paneState.restorable.clear();
  }

  function activateRecordHistoryPane(paneId) {
    const view = HISTORY_PANES[paneId];
    if (!view) return;
    const paneState = getHistoryPaneState(paneId);
    const recordId = String(view.getRecordId() || "");
    if (paneState.recordId !== recordId) resetHistoryPaneState(paneState, recordId);
    // Cached entries stay on screen while the refresh runs, so switching back to
    // this tab does not blank the timeline for the length of a request.
    renderRecordHistoryPane(paneId);
    if (recordId) loadRecordHistory(paneId);
  }

  async function loadRecordHistory(paneId) {
    const view = HISTORY_PANES[paneId];
    const paneState = getHistoryPaneState(paneId);
    const recordId = paneState.recordId;
    if (!view || !recordId) return;

    const token = paneState.loadToken + 1;
    paneState.loadToken = token;
    paneState.status = paneState.entries.length > 0 ? "refreshing" : "loading";
    renderRecordHistoryPane(paneId);

    try {
      const query = `section=${encodeURIComponent(view.section)}`
        + `&id=${encodeURIComponent(recordId)}&limit=${HISTORY_READ_LIMIT}`;
      const response = await fetch(`${API_STATE_URL}/history?${query}`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      // A second activation while this one was in flight owns the pane now.
      if (paneState.loadToken !== token || paneState.recordId !== recordId) return;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.message || payload.error || t("app.loadRecordHistory.requestFailed", { status: response.status }));
      }
      paneState.entries = Array.isArray(payload.entries) ? payload.entries : [];
      paneState.total = Number(payload.total) || 0;
      paneState.available = payload.available !== false;
      paneState.status = "ready";
      paneState.error = "";
      // Session coalescing means a reload can extend the newest entry rather
      // than add one, so cached line counts keyed by entry id can be stale.
      paneState.diffStats.clear();
    } catch (error) {
      if (paneState.loadToken !== token) return;
      paneState.status = "error";
      paneState.error = error && error.message ? error.message : String(error);
    }
    renderRecordHistoryPane(paneId);
  }

  // The merged server timeline turned into display items: move pairs collapsed,
  // PO activity entries interleaved, and each item annotated with the record as
  // it stood before and after, which is what the comparison view needs.
  function buildRecordHistoryTimeline(paneId) {
    const view = HISTORY_PANES[paneId];
    const paneState = getHistoryPaneState(paneId);
    const record = view.findRecord(paneState.recordId);

    const activities = [];
    if (view.activityLog) {
      const log = Array.isArray(record && record.activityLog) ? record.activityLog : [];
      for (const activity of log) {
        const stamp = getProgramActivityTimestamp(activity);
        if (!Number.isFinite(stamp) || stamp <= 0) continue;
        activities.push({ at: new Date(stamp).toISOString(), activity });
      }
    }

    return historyTimeline.buildTimeline(paneState.entries, { record, activities });
  }

  // `root` is the version of the record the path was read against, so a key
  // holding a dot of its own ("Reach (est.) 2026") stays one crumb instead of
  // being sliced into nonsense. Without it there is nothing to split by, so the
  // whole path becomes a single crumb rather than a wrong one.
  function historyFieldLabel(path, root) {
    const segments = (root && splitHistoryPath(root, path)) || [String(path)];
    return segments.map((segment) => {
      const spaced = segment
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .trim();
      return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : segment;
    }).join(" › ");
  }

  function historyValueKind(value) {
    if (value === undefined) return "missing";
    if (isTruncatedHistoryValue(value)) return "text";
    if (Array.isArray(value)) return "list";
    if (isPlainHistoryObject(value)) return "object";
    if (typeof value === "string") return "text";
    return "scalar";
  }

  function historyValueText(value) {
    if (typeof value === "string") return value;
    if (isTruncatedHistoryValue(value)) return typeof value.text === "string" ? value.text : "";
    if (value === undefined || value === null) return "";
    if (typeof value === "boolean") return value ? t("app.historyValueText.yes") : t("app.historyValueText.no");
    if (typeof value === "number") return String(value);
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function historyListEntryLabel(entry) {
    if (entry === null || entry === undefined) return "empty";
    if (typeof entry !== "object") return String(entry);
    for (const key of ["label", "name", "title", "platform", "reference", "id"]) {
      if (typeof entry[key] === "string" && entry[key].trim()) return entry[key].trim();
    }
    return historyValueText(entry);
  }

  function renderRecordHistoryPane(paneId) {
    const pane = document.getElementById(paneId);
    const view = HISTORY_PANES[paneId];
    if (!pane || !view) return;
    const paneState = getHistoryPaneState(paneId);
    paneState.restorable.clear();

    if (!paneState.recordId) {
      pane.innerHTML = `<div class="record-history-empty">`
        + `${escapeHtml(t("app.renderRecordHistoryPane.saveThisRecordFirstIts"))}</div>`;
      return;
    }
    if (paneState.status === "loading") {
      pane.innerHTML = `<div class="record-history-empty">${escapeHtml(t("app.renderRecordHistoryPane.loadingHistory"))}</div>`;
      return;
    }
    if (paneState.status === "error") {
      pane.innerHTML = `<div class="record-history-empty record-history-error">`
        + `${tHtml("app.renderRecordHistoryPane.couldNotLoadTheHistory", { error: escapeHtml(paneState.error) })}</div>`
        + `<div class="record-history-head-actions">`
        + `<button class="small-btn secondary-button" type="button" data-history-refresh>${escapeHtml(t("app.renderRecordHistoryPane.tryAgain"))}</button>`
        + `</div>`;
      return;
    }
    if (!paneState.available) {
      pane.innerHTML = `<div class="record-history-empty">`
        + `${t("app.renderRecordHistoryPane.thisDatabaseWasWrittenBefore")} `
        + `${escapeHtml(t("app.renderRecordHistoryPane.editsFromNowOnWill"))}</div>`;
      return;
    }

    const items = buildRecordHistoryTimeline(paneId);
    paneState.timeline = items;

    const changeCount = items.filter((item) => item.kind !== "activity").length;
    const activityCount = items.length - changeCount;
    const summary = [
      t("app.counts.recordedChange", { count: changeCount }),
      activityCount > 0 ? t("app.counts.loggedUpdate", { count: activityCount }) : "",
      paneState.total > paneState.entries.length
        ? t("app.renderRecordHistoryPane.newestOfShown", { length: paneState.entries.length, total: paneState.total })
        : "",
    ].filter(Boolean).join(" · ");

    const parts = [`
      <div class="record-history-head">
        <div class="record-history-summary">${escapeHtml(summary)}</div>
        <div class="record-history-head-actions">
          ${paneState.compare.length
            ? `<button class="small-btn secondary-button record-history-clear-compare" type="button" data-history-compare-clear>${escapeHtml(t("app.renderRecordHistoryPane.clearComparison"))}</button>`
            : ""}
          <button class="record-history-refresh${paneState.status === "refreshing" ? " is-busy" : ""}" type="button" data-history-refresh${paneState.status === "refreshing" ? " disabled" : ""} aria-label="${escapeAttribute(t("app.renderRecordHistoryPane.refreshHistory"))}" data-tooltip="${paneState.status === "refreshing" ? t("app.renderRecordHistoryPane.refreshing") : t("app.renderRecordHistoryPane.reloadThisRecordSHistory")}">${HISTORY_REFRESH_ICON}</button>
        </div>
      </div>`];

    if (paneState.message) {
      parts.push(`<div class="record-history-message">${escapeHtml(paneState.message)}</div>`);
    }
    parts.push(renderHistoryComparePanel(paneId, items));

    if (items.length === 0) {
      parts.push(`<div class="record-history-empty">`
        + `${escapeHtml(t("app.renderRecordHistoryPane.nothingRecordedForThisRecord"))}</div>`);
    } else {
      parts.push(renderHistoryDayGroups(paneId, items));
    }

    pane.innerHTML = parts.join("");
  }

  // The app's time zone, so a change made late in the evening lands on the day it
  // was made rather than the day UTC had reached. The label is also the grouping
  // key: it already names one calendar day and nothing else.
  function historyDayLabel(value) {
    if (!value) return t("app.historyDayLabel.undated");
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return t("app.historyDayLabel.undated");
    return getDateFormatter("historyDay", {
      timeZone: getTimeZone(),
      weekday: "long",
      day: "2-digit",
      month: "long",
      year: "numeric",
    }).format(date);
  }

  function groupHistoryItemsByDay(items) {
    const groups = [];
    let current = null;
    for (const item of items) {
      const label = historyDayLabel(item.at);
      // The timeline already runs newest first, so a run of matching labels is a
      // day; no sorting or keyed lookup needed.
      if (!current || current.label !== label) {
        current = { label, items: [] };
        groups.push(current);
      }
      current.items.push(item);
    }
    return groups;
  }

  function renderHistoryDayGroups(paneId, items) {
    const paneState = getHistoryPaneState(paneId);
    return groupHistoryItemsByDay(items).map((group) => {
      const open = !paneState.collapsedDays.has(group.label);
      const changes = group.items.filter((item) => item.kind !== "activity").length;
      const logged = group.items.length - changes;
      const counts = [
        changes > 0 ? t("app.counts.change", { count: changes }) : "",
        logged > 0 ? t("app.counts.logged", { count: logged }) : "",
      ].filter(Boolean).join(" · ");
      return `<details class="record-history-day" data-history-day="${escapeAttribute(group.label)}"${open ? " open" : ""}>`
        + `<summary class="record-history-day-head">`
        + `<span class="record-history-day-label">${escapeHtml(group.label)}</span>`
        + `<span class="record-history-day-count">${escapeHtml(counts)}</span>`
        + `</summary>`
        + `<div class="record-history-timeline">`
        + group.items.map((item) => renderHistoryItem(paneId, item)).join("")
        + `</div></details>`;
    }).join("");
  }

  function renderHistoryComparePanel(paneId, items) {
    const paneState = getHistoryPaneState(paneId);
    const chosen = paneState.compare
      .map((key) => items.find((item) => item.key === key))
      .filter(Boolean);
    if (chosen.length === 0) return "";
    if (chosen.length === 1) {
      return `<div class="record-history-compare record-history-compare-waiting">`
        + `${t("app.renderHistoryComparePanel.comparingFrom", { at: escapeHtml(formatTimestamp(chosen[0].at)) })} `
        + `${escapeHtml(t("app.renderHistoryComparePanel.pickASecondEntry"))}</div>`;
    }

    // items run newest first, so the smaller index is the later version.
    const first = items.indexOf(chosen[0]);
    const second = items.indexOf(chosen[1]);
    const newer = first < second ? chosen[0] : chosen[1];
    const older = first < second ? chosen[1] : chosen[0];
    const fields = describeHistoryChanges(older.stateAfter, newer.stateAfter);

    const heading = `<div class="record-history-compare-head">`
      + `<strong>${escapeHtml(t("app.renderHistoryComparePanel.comparingVersions"))}</strong>`
      + `<span>${escapeHtml(formatTimestamp(older.at))} → ${escapeHtml(formatTimestamp(newer.at))}</span>`
      + `</div>`;

    if (older.stateAfter === null || newer.stateAfter === null) {
      return `<div class="record-history-compare">${heading}`
        + `<div class="record-history-note">${escapeHtml(t("app.renderHistoryComparePanel.oneOfTheseVersionsIs"))} `
        + `${escapeHtml(t("app.renderHistoryComparePanel.soThereIsNothingTo"))}</div></div>`;
    }
    if (fields.length === 0) {
      return `<div class="record-history-compare">${heading}`
        + `<div class="record-history-note">${escapeHtml(t("app.renderHistoryComparePanel.theseTwoVersionsHoldThe"))}</div></div>`;
    }
    return `<div class="record-history-compare">${heading}`
      + fields.map((field) => renderHistoryFieldBlock(paneId, `cmp-${older.key}-${newer.key}`, field, newer.stateAfter)).join("")
      + `</div>`;
  }

  function renderHistoryItem(paneId, item) {
    if (item.kind === "activity") return renderHistoryActivityItem(paneId, item);

    const paneState = getHistoryPaneState(paneId);
    const entry = item.entry;
    const selected = paneState.compare.includes(item.key);
    const open = paneState.expandedEntries.has(item.key);
    const title = item.kind === "move"
      ? (item.toBin ? t("app.renderHistoryItem.movedToTheRecycleBin") : t("app.renderHistoryItem.restoredFromTheRecycleBin"))
      : (entry.event === "created" ? t("app.renderHistoryItem.created")
        : entry.event === "deleted" ? t("app.renderHistoryItem.deleted") : t("app.renderHistoryItem.edited"));

    const badges = [];
    // An entry written before origins were stamped, or by something that named
    // an origin this build does not know, still gets a badge rather than the
    // word "undefined".
    const origin = entry.origin || "unknown";
    // A browser edit is one person sitting at the keyboard, so their name says
    // everything the word "Browser" would and more. Every other origin keeps its
    // own label and shows the actor separately, because there "Reconstructed" and
    // the git author it came from are two different facts.
    const namedByActor = origin === "ui" && Boolean(entry.actor);
    badges.push(`<span class="record-history-badge record-history-badge-${escapeAttribute(origin)}">`
      + `${escapeHtml(namedByActor ? entry.actor : (HISTORY_ORIGIN_LABELS[origin] || origin))}</span>`);
    if (item.approximate) {
      badges.push(`<span class="record-history-badge record-history-badge-approximate"`
        + ` data-tooltip="${escapeAttribute(t("app.renderHistoryItem.approximateTooltip"))}">`
        + `${escapeHtml(t("app.renderHistoryItem.approximate"))}</span>`);
    }
    if (entry.actor && !namedByActor) {
      badges.push(`<span class="record-history-badge">${escapeHtml(entry.actor)}</span>`);
    }

    const notes = [];
    if (entry.label) {
      notes.push(`<div class="record-history-entry-label">${escapeHtml(entry.label)}</div>`);
    }
    if (entry.sessionStartedAt && entry.sessionStartedAt !== entry.changedAt) {
      notes.push(`<div class="record-history-session">${escapeHtml(t("app.renderHistoryItem.groupedEditsFrom"))} `
        + `${escapeHtml(formatTimestamp(entry.sessionStartedAt))} to `
        + `${escapeHtml(formatTimestamp(entry.changedAt))}</div>`);
    }

    let body = "";
    if (item.kind === "move") {
      body = `<div class="record-history-note">`
        + (item.toBin
          ? t("app.renderHistoryItem.theRecordWasPutIn")
          : t("app.renderHistoryItem.theRecordWasTakenOut"))
        + `</div>`;
    } else if (entry.event === "deleted") {
      body = `<div class="record-history-note">`
        + `${escapeHtml(t("app.renderHistoryItem.theRecordWasRemovedIts"))}</div>`;
    } else if ((entry.fields || []).length === 0) {
      body = entry.event === "created"
        ? `<div class="record-history-note">${escapeHtml(t("app.renderHistoryItem.theRecordWasCreated"))}</div>`
        : `<div class="record-history-note">${escapeHtml(t("app.renderHistoryItem.noFieldValuesWereRecorded"))}</div>`;
    } else {
      body = entry.fields
        .map((field) => renderHistoryFieldBlock(paneId, `e${entry.entryId}`, field, item.stateAfter || item.stateBefore))
        .join("");
    }

    return `
      <details class="record-history-entry record-history-entry-${escapeAttribute(item.kind === "move" ? "move" : entry.event)}${selected ? " is-comparing" : ""}" data-history-entry="${escapeAttribute(item.key)}"${open ? " open" : ""}>
        <summary class="record-history-entry-head">
          <span class="record-history-event">${escapeHtml(title)}</span>
          ${renderHistoryEntryTime(item.at)}
          <div class="record-history-badges">${badges.join("")}</div>
          ${renderHistoryEntryDigest(paneId, item)}
          <button class="small-btn secondary-button record-history-compare-btn${selected ? " is-active" : ""}" type="button" data-history-compare="${escapeAttribute(item.key)}">${selected ? t("app.renderHistoryItem.selected") : t("app.renderHistoryItem.compare")}</button>
        </summary>
        <div class="record-history-entry-body">
          ${notes.join("")}
          ${body}
        </div>
      </details>`;
  }

  // The day group above already names the date, so the row shows the clock time
  // and keeps the full stamp in the tooltip.
  function renderHistoryEntryTime(at) {
    return `<time datetime="${escapeAttribute(String(at || ""))}"`
      + ` data-tooltip="${escapeAttribute(formatTimestamp(at))}">`
      + `${escapeHtml(historyTimeOfDay(at) || formatTimestamp(at))}</time>`;
  }

  function historyTimeOfDay(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return getDateFormatter("historyTime", {
      timeZone: getTimeZone(),
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date);
  }

  // Which text fields in an entry are worth a line diff, and the two strings to
  // diff. The collapsed digest and the opened body both go through this, so the
  // "+12 −3" on the summary counts exactly the lines the diff below it shows.
  function historyTextDiffTexts(field) {
    const kinds = new Set([historyValueKind(field.before), historyValueKind(field.after)]);
    kinds.delete("missing");
    if (kinds.has("list") || kinds.has("object") || !kinds.has("text")) return null;
    const before = historyValueText(field.before);
    const after = historyValueText(field.after);
    const leaf = String(field.path).split(".").pop();
    const worthDiffing = HISTORY_TEXT_FIELDS.has(leaf)
      || before.includes("\n") || after.includes("\n")
      || before.length > HISTORY_TEXT_DIFF_MIN_LENGTH
      || after.length > HISTORY_TEXT_DIFF_MIN_LENGTH;
    return worthDiffing ? { before, after } : null;
  }

  function historyDiffStats(paneId, fieldKey, beforeText, afterText) {
    const paneState = getHistoryPaneState(paneId);
    const cached = paneState.diffStats.get(fieldKey);
    if (cached) return cached;
    const diff = globalThis.RecordHistoryDiff;
    const stats = diff
      ? diff.summarize(diff.diffLines(beforeText, afterText))
      : { added: 0, removed: 0, changed: false };
    paneState.diffStats.set(fieldKey, stats);
    return stats;
  }

  // What one collapsed entry says about itself. A status move is the fact worth
  // reading first, then the lines of prose that moved, then how many other
  // fields were touched. Who made the change is already in the badges.
  function summariseHistoryEntry(paneId, item) {
    const entry = item.entry;
    const fields = Array.isArray(entry && entry.fields) ? entry.fields : [];
    let added = 0;
    let removed = 0;
    let textFields = 0;
    for (const field of fields) {
      if (field.path === "status") continue;
      const texts = historyTextDiffTexts(field);
      if (!texts) continue;
      const stats = historyDiffStats(paneId, `e${entry.entryId}::${field.path}`, texts.before, texts.after);
      added += stats.added;
      removed += stats.removed;
      textFields += 1;
    }
    const statusField = fields.find((field) => field.path === "status") || null;
    // textFields comes out of fieldCount because the +N −M chip already speaks
    // for those fields; the count is meant to be what else moved.
    return { added, removed, fieldCount: fields.length, textFields, statusField };
  }

  function renderHistoryEntryDigest(paneId, item) {
    if (item.kind === "move") {
      return `<div class="record-history-digest">`
        + `<span class="record-history-digest-empty">${escapeHtml(t("app.renderHistoryEntryDigest.valuesUntouched"))}</span></div>`;
    }
    const section = (HISTORY_PANES[paneId] || {}).section;
    const digest = summariseHistoryEntry(paneId, item);
    const chips = [];

    if (digest.statusField) {
      // MK stores status ids, PO and FU store the label itself, so only MK gets
      // looked up. Running the lookup over the others would try to relabel what
      // is already a label.
      const label = (value) => {
        const text = historyValueText(value);
        if (!text) return t("app.renderHistoryEntryDigest.notSet");
        return section === "items" ? getStatusLabel(text) : text;
      };
      chips.push(`<span class="record-history-digest-status">`
        + `<span class="record-history-digest-status-before">${escapeHtml(label(digest.statusField.before))}</span>`
        + `<span class="record-history-digest-status-arrow" aria-hidden="true">→</span>`
        + `<span class="record-history-digest-status-after">${escapeHtml(label(digest.statusField.after))}</span>`
        + `</span>`);
    }
    if (digest.added || digest.removed) {
      chips.push(`<span class="record-history-digest-lines" data-tooltip="${escapeAttribute(t("app.renderHistoryEntryDigest.linesAddedAndRemovedAcross"))}">`
        + `<span class="record-history-diff-added">+${digest.added}</span>`
        + `<span class="record-history-diff-removed">−${digest.removed}</span>`
        + `</span>`);
    }
    const others = digest.fieldCount - digest.textFields - (digest.statusField ? 1 : 0);
    if (others > 0) {
      chips.push(`<span class="record-history-digest-fields" data-tooltip="${escapeAttribute(t("app.renderHistoryEntryDigest.otherFieldsChangedInThis"))}">`
        + `${escapeHtml(t("app.counts.field", { count: others }))}</span>`);
    }
    if (chips.length === 0) {
      const event = item.entry && item.entry.event;
      chips.push(`<span class="record-history-digest-empty">`
        + `${event === "created" ? t("app.renderHistoryEntryDigest.recordCreated") : event === "deleted" ? t("app.renderHistoryEntryDigest.recordRemoved") : t("app.renderHistoryEntryDigest.nothingRecorded")}`
        + `</span>`);
    }
    return `<div class="record-history-digest">${chips.join("")}</div>`;
  }

  function renderHistoryActivityItem(paneId, item) {
    const paneState = getHistoryPaneState(paneId);
    const open = paneState.expandedEntries.has(item.key);
    const activity = item.activity;
    const meta = [
      activity.owner ? t("app.renderHistoryActivityItem.owner", { owner: activity.owner }) : "",
      activity.statusAfter ? t("app.renderHistoryActivityItem.status", { statusAfter: activity.statusAfter }) : "",
      activity.round ? t("app.renderHistoryActivityItem.round", { round: activity.round }) : "",
    ].filter(Boolean);
    const blocks = [
      activity.outcome ? [t("app.renderHistoryActivityItem.outcome"), activity.outcome] : null,
      activity.previousAction
        ? [t("app.renderHistoryActivityItem.previousAction", { previousActionStatus: getProgramPreviousActionStatusLabel(activity.previousActionStatus) }), activity.previousAction]
        : null,
      activity.nextAction ? [t("ui.common.nextAction"), activity.nextAction] : null,
      activity.blocker ? [t("app.renderHistoryActivityItem.blocker"), activity.blocker] : null,
      activity.notes ? [t("app.renderHistoryActivityItem.note"), activity.notes] : null,
    ].filter(Boolean);

    const digest = activity.statusAfter
      ? `<span class="record-history-digest-status">`
        + `<span class="record-history-digest-status-after">${escapeHtml(activity.statusAfter)}</span></span>`
      : `<span class="record-history-digest-fields">${escapeHtml(t("app.counts.note", { count: blocks.length }))}</span>`;

    return `
      <details class="record-history-entry record-history-entry-activity" data-history-entry="${escapeAttribute(item.key)}"${open ? " open" : ""}>
        <summary class="record-history-entry-head">
          <span class="record-history-event">${escapeHtml(getProgramActivityTypeLabel(activity.type))}</span>
          ${renderHistoryEntryTime(item.at)}
          <div class="record-history-badges">
            <span class="record-history-badge record-history-badge-activity">${escapeHtml(t("app.renderHistoryActivityItem.loggedByHand"))}</span>
          </div>
          <div class="record-history-digest">${digest}</div>
        </summary>
        <div class="record-history-entry-body">
          ${meta.length ? `<div class="record-history-session">${escapeHtml(meta.join(" · "))}</div>` : ""}
          ${blocks.map(([label, text]) => `<div class="record-history-activity-block">`
            + `<strong>${escapeHtml(label)}</strong><br>${escapeHtml(text)}</div>`).join("")}
        </div>
      </details>`;
  }

  function renderHistoryFieldBlock(paneId, entryKey, field, root) {
    const paneState = getHistoryPaneState(paneId);
    const fieldKey = `${entryKey}::${field.path}`;
    const hasBefore = Object.prototype.hasOwnProperty.call(field, "before");
    // A clamped value is not the value, so putting it back would truncate the
    // record rather than restore it.
    const restorable = hasBefore && !isTruncatedHistoryValue(field.before);
    const label = historyFieldLabel(field.path, root);
    if (restorable) paneState.restorable.set(fieldKey, { path: field.path, value: field.before });

    return `
      <div class="record-history-field">
        <div class="record-history-field-head">
          <span class="record-history-field-name">${escapeHtml(label)}</span>
          ${restorable
            ? `<button class="small-btn secondary-button" type="button" data-history-restore="${escapeAttribute(fieldKey)}">${escapeHtml(t("app.renderHistoryFieldBlock.restoreThisValue"))}</button>`
            : ""}
        </div>
        ${renderHistoryFieldValue(paneId, fieldKey, field, label)}
      </div>`;
  }

  function renderHistoryFieldValue(paneId, fieldKey, field, label) {
    const kinds = new Set([historyValueKind(field.before), historyValueKind(field.after)]);
    kinds.delete("missing");

    const truncationNote = [field.before, field.after]
      .filter((value) => isTruncatedHistoryValue(value))
      .map((value) => `<div class="record-history-note">`
        + t("app.renderHistoryFieldValue.onlyTheFirstPartOf", { length: escapeHtml(String(value.length || "?")) })
        + `</div>`)
      .join("");

    let body = "";
    if (kinds.has("list")) {
      body = renderHistoryListChange(field.before, field.after);
    } else if (kinds.has("object")) {
      body = renderHistoryJsonChange(field.before, field.after);
    } else if (kinds.has("text")) {
      const texts = historyTextDiffTexts(field);
      body = texts
        ? renderHistoryTextDiff(paneId, fieldKey, texts.before, texts.after, label)
        : renderHistoryScalarChange(field.before, field.after);
    } else {
      body = renderHistoryScalarChange(field.before, field.after);
    }
    return truncationNote + body;
  }

  function renderHistoryTextDiff(paneId, fieldKey, beforeText, afterText, label) {
    const paneState = getHistoryPaneState(paneId);
    const wrapped = paneState.wrapFields.has(fieldKey);
    // The rendered markdown opens in its own window, so the texts have to be
    // reachable from a click on a button that only carries the field key.
    paneState.previewable.set(fieldKey, { label: label || fieldKey, before: beforeText, after: afterText });

    const gapPrefix = `${fieldKey}::`;
    let hasOpenGap = false;
    for (const key of paneState.gapReveals.keys()) {
      if (key.startsWith(gapPrefix)) {
        hasOpenGap = true;
        break;
      }
    }
    // Offered only once this diff is no longer the way it opened, so the row
    // stays two buttons wide until there is something to undo.
    const reset = wrapped || hasOpenGap
      ? `<button class="small-btn secondary-button" type="button" data-history-view-reset="${escapeAttribute(fieldKey)}" data-tooltip="${escapeAttribute(t("app.renderHistoryTextDiff.foldEveryUnchangedLineBack"))}">${escapeHtml(t("app.renderHistoryTextDiff.resetView"))}</button>`
      : "";

    const modes = `
      <div class="record-history-modes">
        <button class="small-btn secondary-button${wrapped ? " is-active" : ""}" type="button" aria-pressed="${wrapped ? "true" : "false"}" data-history-wrap="${escapeAttribute(fieldKey)}" data-tooltip="${wrapped ? t("app.renderHistoryTextDiff.putLongLinesBackOn") : t("app.renderHistoryTextDiff.wrapLongLinesInsteadOf")}">${escapeHtml(t("app.renderHistoryTextDiff.wordWrap"))}</button>
        <button class="small-btn secondary-button" type="button" data-history-preview="${escapeAttribute(fieldKey)}" data-tooltip="${escapeAttribute(t("app.renderHistoryTextDiff.openTheRenderedMarkdownIn"))}">${escapeHtml(t("app.renderHistoryTextDiff.markdownPreview"))}</button>
        ${reset}
      </div>`;

    const diff = globalThis.RecordHistoryDiff;
    if (!diff) {
      return modes + `<pre class="record-history-plain">${escapeHtml(afterText)}</pre>`;
    }
    const rows = diff.diffLines(beforeText, afterText);
    const grouped = diff.groupHunks(rows, { contextLines: HISTORY_DIFF_CONTEXT_LINES });
    if (grouped.unchanged) {
      return modes + `<div class="record-history-note">${escapeHtml(t("app.renderHistoryTextDiff.noVisibleDifferenceInThis"))}</div>`;
    }
    const stats = historyDiffStats(paneId, fieldKey, beforeText, afterText);

    const gapsByHunk = new Map();
    grouped.gaps.forEach((gap, gapIndex) => {
      const list = gapsByHunk.get(gap.afterHunkIndex) || [];
      list.push({ gap, gapIndex });
      gapsByHunk.set(gap.afterHunkIndex, list);
    });

    const pieces = [];
    const emitGaps = (afterHunkIndex) => {
      for (const { gap, gapIndex } of gapsByHunk.get(afterHunkIndex) || []) {
        pieces.push(renderHistoryDiffGap(paneId, `${fieldKey}::gap${gapIndex}`, gap, {
          hasChangeAbove: gap.afterHunkIndex >= 0,
          hasChangeBelow: gap.afterHunkIndex + 1 < grouped.hunks.length,
        }));
      }
    };

    emitGaps(-1);
    grouped.hunks.forEach((hunk, hunkIndex) => {
      pieces.push(`<div class="record-history-diff-rows">`
        + hunk.rows.map(renderHistoryDiffRow).join("") + `</div>`);
      emitGaps(hunkIndex);
    });

    const counters = `<div class="record-history-diff-stats">`
      + `<span class="record-history-diff-added">+${stats.added}</span>`
      + `<span class="record-history-diff-removed">−${stats.removed}</span>`
      + `</div>`;
    return modes + `<div class="record-history-diff${wrapped ? " is-wrapped" : ""}">`
      + `${counters}${pieces.join("")}</div>`;
  }

  // A hidden run of unchanged lines opens five at a time from either end: down
  // from the change above it, up from the change below it. Reading the few lines
  // either side of an edit is the usual reason to open one at all, and on a long
  // note unfolding the whole run buries the change instead.
  //
  // A direction is only offered where there is a change to read out from, which
  // is what keeps the bar at an edge of the diff: the run before the first change
  // opens upwards and its bar stays at the top, the run after the last change
  // opens downwards and its bar stays at the bottom, instead of either of them
  // walking into the middle of the lines it just uncovered.
  function renderHistoryDiffGap(paneId, gapKey, gap, position = {}) {
    const paneState = getHistoryPaneState(paneId);
    const total = gap.rows.length;
    const canOpenDown = position.hasChangeAbove !== false;
    const canOpenUp = position.hasChangeBelow !== false;
    const reveal = paneState.gapReveals.get(gapKey) || { head: 0, tail: 0 };
    // What was asked of a direction that has nowhere to open moves to the other
    // end rather than being dropped, so "show all" still lands at either edge.
    let head = canOpenDown ? reveal.head : 0;
    let tail = canOpenUp ? reveal.tail : 0;
    if (!canOpenDown) tail += reveal.head;
    if (!canOpenUp) head += reveal.tail;
    head = Math.max(0, Math.min(head, total));
    tail = Math.max(0, Math.min(tail, total - head));
    const hidden = total - head - tail;
    const rowsBlock = (rows) => `<div class="record-history-diff-rows">`
      + rows.map(renderHistoryDiffRow).join("") + `</div>`;
    const step = (edge, text, tooltip) => `<button class="record-history-diff-step" type="button"`
      + ` data-history-gap="${escapeAttribute(gapKey)}" data-history-gap-edge="${edge}"`
      + ` data-tooltip="${escapeAttribute(tooltip)}">${escapeHtml(text)}</button>`;
    const count = (text) => `<span class="record-history-diff-gap-count">${text}</span>`;

    const controls = [];
    if (hidden > 0) {
      if (canOpenDown) {
        controls.push(step("head", `↓ ${HISTORY_GAP_STEP}`,
          t("app.renderHistoryDiffGap.showMoreLinesBelowThe", { HISTORY_GAP_STEP })));
      }
      if (canOpenUp) {
        controls.push(step("tail", `↑ ${HISTORY_GAP_STEP}`,
          t("app.renderHistoryDiffGap.showMoreLinesAboveThe", { HISTORY_GAP_STEP })));
      }
      controls.push(count(t("app.counts.unchangedLinesHidden", { count: hidden })));
      controls.push(step("all", t("app.renderHistoryDiffGap.showAll", { total }), t("app.renderHistoryDiffGap.showEveryUnchangedLineIn")));
    } else {
      controls.push(count(t("app.counts.unchangedLinesShown", { count: total })));
    }
    // The way back from both the five-line steps and the whole run, so it belongs
    // in the bar as soon as either has been used.
    if (head + tail > 0) {
      controls.push(step("none", t("app.renderHistoryDiffGap.hideAgain"), t("app.renderHistoryDiffGap.foldTheseUnchangedLinesBack")));
    }

    return (head > 0 ? rowsBlock(gap.rows.slice(0, head)) : "")
      + `<div class="record-history-diff-gap">${controls.join("")}</div>`
      + (tail > 0 ? rowsBlock(gap.rows.slice(total - tail)) : "");
  }

  function renderHistoryDiffRow(row) {
    const sign = row.type === "add" ? "+" : row.type === "remove" ? "−" : " ";
    const lineNumber = row.type === "add" ? row.afterLine : row.beforeLine;
    const body = Array.isArray(row.segments) && row.segments.length
      ? row.segments.map((segment) => (segment.type === "same"
        ? escapeHtml(segment.text)
        : `<mark class="record-history-segment-${escapeAttribute(segment.type)}">${escapeHtml(segment.text)}</mark>`)).join("")
      : escapeHtml(row.text);
    return `<div class="record-history-diff-row record-history-diff-${escapeAttribute(row.type)}">`
      + `<span class="record-history-diff-gutter">${lineNumber === null || lineNumber === undefined ? "" : lineNumber}</span>`
      + `<span class="record-history-diff-sign">${sign}</span>`
      + `<span class="record-history-diff-text">${body || " "}</span>`
      + `</div>`;
  }

  function renderHistoryListChange(before, after) {
    const beforeList = Array.isArray(before) ? before : [];
    const afterList = Array.isArray(after) ? after : [];
    const signature = (entry) => JSON.stringify(normalizeComparableValue(entry));
    const beforeSignatures = beforeList.map(signature);
    const afterSignatures = afterList.map(signature);
    const added = afterList.filter((entry, index) => !beforeSignatures.includes(afterSignatures[index]));
    const removed = beforeList.filter((entry, index) => !afterSignatures.includes(beforeSignatures[index]));

    if (added.length === 0 && removed.length === 0) {
      return `<div class="record-history-note">`
        + `${escapeHtml(t("app.counts.reordered", { count: afterList.length }))} `
        + `${escapeHtml(t("app.renderHistoryListChange.sameValuesThroughout"))}</div>`;
    }
    const chips = [
      ...removed.map((entry) => `<span class="record-history-chip record-history-chip-removed">`
        + `${escapeHtml(historyListEntryLabel(entry))}</span>`),
      ...added.map((entry) => `<span class="record-history-chip record-history-chip-added">`
        + `${escapeHtml(historyListEntryLabel(entry))}</span>`),
    ];
    return `<div class="record-history-chips">${chips.join("")}</div>`;
  }

  function renderHistoryJsonChange(before, after) {
    const blocks = [];
    if (before !== undefined) {
      blocks.push(`<pre class="record-history-json record-history-json-before">`
        + `${escapeHtml(historyValueText(before))}</pre>`);
    }
    if (after !== undefined) {
      blocks.push(`<pre class="record-history-json record-history-json-after">`
        + `${escapeHtml(historyValueText(after))}</pre>`);
    }
    return `<div class="record-history-json-pair">${blocks.join("")}</div>`;
  }

  function renderHistoryScalarChange(before, after) {
    const cell = (value, missingLabel) => {
      if (value === undefined) return `<em class="record-history-blank">${escapeHtml(missingLabel)}</em>`;
      const text = historyValueText(value);
      if (text === "") return `<em class="record-history-blank">${escapeHtml(t("app.renderHistoryScalarChange.empty"))}</em>`;
      return escapeHtml(text);
    };
    return `<div class="record-history-scalar">`
      + `<span class="record-history-scalar-before">${cell(before, t("app.renderHistoryScalarChange.notSet"))}</span>`
      + `<span class="record-history-scalar-arrow" aria-hidden="true">→</span>`
      + `<span class="record-history-scalar-after">${cell(after, "removed")}</span>`
      + `</div>`;
  }

  function toggleHistoryCompare(paneId, key) {
    const paneState = getHistoryPaneState(paneId);
    const index = paneState.compare.indexOf(key);
    if (index !== -1) paneState.compare.splice(index, 1);
    else paneState.compare.push(key);
    // Two versions is a comparison; a third would just be the oldest dropping
    // out silently, so the earliest pick makes room for the new one.
    while (paneState.compare.length > 2) paneState.compare.shift();
    paneState.message = "";
    renderRecordHistoryPane(paneId);
  }

  // Restoring writes to the record and saves, so the dialog above shows the
  // value going in next to the one it replaces. This runs once the user has
  // confirmed there.
  function restoreHistoryFieldValue(paneId, fieldKey) {
    const view = HISTORY_PANES[paneId];
    const paneState = getHistoryPaneState(paneId);
    const target = paneState.restorable.get(fieldKey);
    if (!view || !target) return;

    const record = view.findRecord(paneState.recordId);
    if (!record) {
      paneState.message = t("app.restoreHistoryFieldValue.thatRecordIsNoLonger");
      renderRecordHistoryPane(paneId);
      return;
    }
    const label = historyFieldLabel(target.path, record);

    const slot = resolveHistoryPath(record, target.path, true);
    if (!slot) {
      paneState.message = t("app.restoreHistoryFieldValue.couldNotWorkOutWhere", { label });
      renderRecordHistoryPane(paneId);
      return;
    }
    slot.container[slot.key] = cloneComparableValue(target.value);
    record.updatedAt = new Date().toISOString();

    render();
    persist(t("app.restoreHistoryFieldValue.restored", { label }));
    // Re-opening repopulates every control from the record. Writing the value
    // straight onto the record would otherwise leave the form showing the old
    // one, and the unsaved-changes baseline pointing at a version that is gone.
    view.reopen(paneState.recordId);
  }

  // Markdown preview window --------------------------------------------------

  // Focus has to wait for the overlay to actually become visible.
  // `.modal-overlay` transitions `visibility`, and focus() on a still-hidden
  // element silently does nothing — one frame is not enough, the flip lands a
  // little after the class does.
  function openHistoryDialog(modal, pickFocus) {
    window.requestAnimationFrame(() => {
      modal.classList.add("open");
      window.setTimeout(() => {
        if (!modal.classList.contains("open")) return;
        pickFocus()?.focus();
      }, 40);
    });
  }

  function openHistoryPreviewDialog(paneId, fieldKey) {
    const modal = elements.historyPreviewModal;
    const paneState = getHistoryPaneState(paneId);
    const target = paneState.previewable.get(fieldKey);
    if (!modal || !target) return;

    if (elements.historyPreviewModalField) {
      elements.historyPreviewModalField.textContent = target.label;
    }
    const blocks = [];
    if (target.before) {
      blocks.push(`<div class="record-history-preview record-history-preview-before">`
        + `<span class="record-history-preview-label">${escapeHtml(t("app.openHistoryPreviewDialog.before"))}</span>`
        + `<div class="markdown-rendered">${renderMarkdown(target.before)}</div></div>`);
    }
    blocks.push(`<div class="record-history-preview record-history-preview-after">`
      + `<span class="record-history-preview-label">${target.before ? t("app.openHistoryPreviewDialog.after") : t("ui.common.value2")}</span>`
      + `<div class="markdown-rendered">${renderMarkdown(target.after)}</div></div>`);
    if (elements.historyPreviewModalBody) {
      elements.historyPreviewModalBody.innerHTML = blocks.join("");
      elements.historyPreviewModalBody.scrollTop = 0;
    }

    historyDialogReturnFocus = document.activeElement;
    modal.hidden = false;
    openHistoryDialog(modal, () => elements.closeHistoryPreviewModal);
  }

  function closeHistoryPreviewDialog() {
    closeHistoryDialog(elements.historyPreviewModal);
  }

  // Restore confirmation window ---------------------------------------------

  function openHistoryRestoreDialog(paneId, fieldKey) {
    const modal = elements.historyRestoreModal;
    const view = HISTORY_PANES[paneId];
    const paneState = getHistoryPaneState(paneId);
    const target = paneState.restorable.get(fieldKey);
    if (!modal || !view || !target) return;

    const record = view.findRecord(paneState.recordId);
    if (!record) {
      paneState.message = t("app.openHistoryRestoreDialog.thatRecordIsNoLonger");
      renderRecordHistoryPane(paneId);
      return;
    }
    const label = historyFieldLabel(target.path, record);
    // Read without creating: a path that does not exist on the record yet should
    // show as "not set", not be brought into being by opening a dialog.
    const slot = resolveHistoryPath(record, target.path, false);
    const currentValue = slot ? slot.container[slot.key] : undefined;
    const unchanged = historyValuesEqual(currentValue, target.value);

    if (elements.historyRestoreModalField) {
      elements.historyRestoreModalField.textContent = label;
    }
    if (elements.historyRestoreModalBody) {
      elements.historyRestoreModalBody.innerHTML = renderHistoryRestorePreview(currentValue, target.value, unchanged);
      elements.historyRestoreModalBody.scrollTop = 0;
    }
    if (elements.confirmHistoryRestoreModal) {
      elements.confirmHistoryRestoreModal.disabled = unchanged;
    }

    historyRestoreRequest = { paneId, fieldKey };
    historyDialogReturnFocus = document.activeElement;
    modal.hidden = false;
    openHistoryDialog(modal, () => (unchanged
      ? elements.cancelHistoryRestoreModal
      : elements.confirmHistoryRestoreModal));
  }

  function renderHistoryRestorePreview(currentValue, nextValue, unchanged) {
    // The dialog subtitle already names the field, so this starts with the
    // consequence instead of repeating the label.
    const parts = [];
    if (unchanged) {
      parts.push(`<div class="history-dialog-note">`
        + `${escapeHtml(t("app.renderHistoryRestorePreview.theRecordAlreadyHoldsThis"))}</div>`);
    } else {
      parts.push(`<div class="history-dialog-warning">`
        + `${t("app.renderHistoryRestorePreview.savingReplacesWhatTheRecord")} `
        + `${escapeHtml(t("app.renderHistoryRestorePreview.fromThisTimelineTheSame"))}</div>`);
    }
    const block = (title, value, variant) => {
      const kind = historyValueKind(value);
      const inner = kind === "missing"
        ? `<em class="record-history-blank">${escapeHtml(t("app.renderHistoryRestorePreview.notSet"))}</em>`
        : historyValueText(value) === ""
          ? `<em class="record-history-blank">${escapeHtml(t("app.renderHistoryRestorePreview.empty"))}</em>`
          : `<pre class="record-history-json record-history-json-${variant}">`
            + `${escapeHtml(historyValueText(value))}</pre>`;
      return `<div class="record-history-preview record-history-preview-${variant}">`
        + `<span class="record-history-preview-label">${escapeHtml(title)}</span>`
        + inner + `</div>`;
    };
    parts.push(block(t("app.renderHistoryRestorePreview.valueNow"), currentValue, "before"));
    parts.push(block(t("app.renderHistoryRestorePreview.willBecome"), nextValue, "after"));
    return parts.join("");
  }

  function closeHistoryRestoreDialog() {
    historyRestoreRequest = null;
    closeHistoryDialog(elements.historyRestoreModal);
  }

  function confirmHistoryRestoreDialog() {
    const request = historyRestoreRequest;
    closeHistoryRestoreDialog();
    if (request) restoreHistoryFieldValue(request.paneId, request.fieldKey);
  }

  function closeHistoryDialog(modal) {
    if (!modal) return;
    modal.classList.remove("open");
    window.setTimeout(() => {
      if (!modal.classList.contains("open")) {
        modal.hidden = true;
        if (historyDialogReturnFocus?.isConnected) historyDialogReturnFocus.focus();
        historyDialogReturnFocus = null;
      }
    }, 300);
  }

  function bindHistoryDialogs() {
    elements.closeHistoryPreviewModal?.addEventListener("click", closeHistoryPreviewDialog);
    elements.historyPreviewModal?.addEventListener("click", (event) => {
      if (event.target === elements.historyPreviewModal) closeHistoryPreviewDialog();
    });
    elements.closeHistoryRestoreModal?.addEventListener("click", closeHistoryRestoreDialog);
    elements.cancelHistoryRestoreModal?.addEventListener("click", closeHistoryRestoreDialog);
    elements.confirmHistoryRestoreModal?.addEventListener("click", confirmHistoryRestoreDialog);
    elements.historyRestoreModal?.addEventListener("click", (event) => {
      if (event.target === elements.historyRestoreModal) closeHistoryRestoreDialog();
    });
  }

  function handleRecordHistoryClick(paneId, event) {
    const paneState = getHistoryPaneState(paneId);

    if (event.target.closest("[data-history-refresh]")) {
      loadRecordHistory(paneId);
      return;
    }
    const gapButton = event.target.closest("[data-history-gap]");
    if (gapButton) {
      // These sit inside a <summary>, so without this the entry would fold shut
      // on the way to uncovering a line inside it.
      event.preventDefault();
      revealHistoryGapLines(paneId, gapButton.dataset.historyGap, gapButton.dataset.historyGapEdge);
      return;
    }
    const wrapButton = event.target.closest("[data-history-wrap]");
    if (wrapButton) {
      event.preventDefault();
      const key = wrapButton.dataset.historyWrap;
      if (paneState.wrapFields.has(key)) paneState.wrapFields.delete(key);
      else paneState.wrapFields.add(key);
      renderRecordHistoryPane(paneId);
      return;
    }
    const viewResetButton = event.target.closest("[data-history-view-reset]");
    if (viewResetButton) {
      event.preventDefault();
      resetHistoryDiffView(paneId, viewResetButton.dataset.historyViewReset);
      return;
    }
    const previewButton = event.target.closest("[data-history-preview]");
    if (previewButton) {
      event.preventDefault();
      openHistoryPreviewDialog(paneId, previewButton.dataset.historyPreview);
      return;
    }
    const compareButton = event.target.closest("[data-history-compare]");
    if (compareButton) {
      event.preventDefault();
      toggleHistoryCompare(paneId, compareButton.dataset.historyCompare);
      return;
    }
    if (event.target.closest("[data-history-compare-clear]")) {
      paneState.compare = [];
      renderRecordHistoryPane(paneId);
      return;
    }
    const restoreButton = event.target.closest("[data-history-restore]");
    if (restoreButton) {
      event.preventDefault();
      openHistoryRestoreDialog(paneId, restoreButton.dataset.historyRestore);
    }
  }

  // Puts one field's diff back the way it opened: every run of unchanged lines
  // folded up again, long lines back on one row each. Only this field, because the
  // pane can hold dozens and the other ones were opened on purpose too.
  function resetHistoryDiffView(paneId, fieldKey) {
    const paneState = getHistoryPaneState(paneId);
    if (!fieldKey) return;
    paneState.wrapFields.delete(fieldKey);
    const gapPrefix = `${fieldKey}::`;
    for (const key of [...paneState.gapReveals.keys()]) {
      if (key.startsWith(gapPrefix)) paneState.gapReveals.delete(key);
    }
    renderRecordHistoryPane(paneId);
  }

  function revealHistoryGapLines(paneId, gapKey, edge) {
    const paneState = getHistoryPaneState(paneId);
    if (!gapKey) return;
    if (edge === "none") {
      paneState.gapReveals.delete(gapKey);
    } else if (edge === "all") {
      paneState.gapReveals.set(gapKey, { head: Number.MAX_SAFE_INTEGER, tail: 0 });
    } else {
      const current = paneState.gapReveals.get(gapKey) || { head: 0, tail: 0 };
      const next = { head: current.head, tail: current.tail };
      if (edge === "tail") next.tail += HISTORY_GAP_STEP;
      else next.head += HISTORY_GAP_STEP;
      paneState.gapReveals.set(gapKey, next);
    }
    renderRecordHistoryPane(paneId);
  }

  // <details> fires toggle on itself and the event does not bubble, so the pane
  // listens in the capture phase instead of binding one handler per entry.
  function handleRecordHistoryToggle(paneId, event) {
    const target = event.target;
    if (!target || typeof target.matches !== "function") return;
    const paneState = getHistoryPaneState(paneId);
    if (target.matches("details.record-history-entry")) {
      const key = target.dataset.historyEntry;
      if (!key) return;
      if (target.open) paneState.expandedEntries.add(key);
      else paneState.expandedEntries.delete(key);
      return;
    }
    if (target.matches("details.record-history-day")) {
      const key = target.dataset.historyDay;
      if (!key) return;
      if (target.open) paneState.collapsedDays.delete(key);
      else paneState.collapsedDays.add(key);
    }
  }

  function bindRecordHistoryPanes() {
    Object.keys(HISTORY_PANES).forEach((paneId) => {
      const pane = document.getElementById(paneId);
      if (!pane) return;
      pane.addEventListener("click", (event) => handleRecordHistoryClick(paneId, event));
      pane.addEventListener("toggle", (event) => handleRecordHistoryToggle(paneId, event), true);
    });
    bindHistoryDialogs();
  }

  // --- All Details View for Notes Modals (MK, PO, FU) ---

  // ---------------------------------------------------------------------------
  // Tags + Extra Parameters
  // ---------------------------------------------------------------------------

  function navigateToTag(rawTagId) {
    const tagId = normalizeTagId(rawTagId);
    if (!tagId) return;

    state.selectedAppTab = "extra";
    state.selectedExtraSubTab = "tags";
    state.tagSearch = "";
    state.tagUsageFilter = "all";

    const records = getFilteredTagRecords(getAllTagRecords());
    const index = records.findIndex((record) => record.id === tagId);
    state.tagPage = index >= 0 ? Math.floor(index / MANAGER_PAGE_SIZE) + 1 : 1;

    render();

    setTimeout(() => {
      const card = document.querySelector(`.tag-card[data-tag-id="${escapeAttribute(tagId)}"]`);
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.classList.add("highlight-flash");
        setTimeout(() => {
          card.classList.remove("highlight-flash");
        }, 2500);
      }
    }, 100);
  }

  function normalizeTagId(raw) {
    return normalizeTagArray([raw])[0] || "";
  }

  function ensureTagDefinition(tagId) {
    const id = normalizeTagId(tagId);
    if (!id) return null;
    let def = tagDefinitions.find((entry) => entry.id === id);
    if (!def) {
      def = { id, label: id, description: "" };
      tagDefinitions.unshift(def);
    }
    return def;
  }

  function getAllTagRecords() {
    if (tagRecordsCache && tagRecordsCache.revision === derivedDataRevision) {
      return tagRecordsCache.records;
    }

    const records = new Map();
    const getRecord = (tag) => {
      const id = normalizeTagId(tag);
      if (!id) return null;
      if (!records.has(id)) {
        records.set(id, {
          id,
          label: id,
          description: "",
          definition: null,
          targets: [],
          programs: [],
          funding: [],
          media: [],
          campaigns: [],
          feedback: [],
        });
      }
      return records.get(id);
    };

    tagDefinitions.forEach((def) => {
      const record = getRecord(def.id);
      if (!record) return;
      record.label = def.label || def.id;
      record.description = def.description || "";
      record.definition = def;
    });

    state.items.forEach((item) => {
      (item.tags || []).forEach((tag) => {
        const record = getRecord(tag);
        if (record) record.targets.push(item);
      });
    });

    state.programs.forEach((program) => {
      (program.tags || []).forEach((tag) => {
        const record = getRecord(tag);
        if (record) record.programs.push(program);
      });
    });

    state.funding.forEach((funding) => {
      (funding.tags || []).forEach((tag) => {
        const record = getRecord(tag);
        if (record) record.funding.push(funding);
      });
    });

    state.mediaItems.forEach((media) => {
      (media.tags || []).forEach((tag) => {
        const record = getRecord(tag);
        if (record) record.media.push(media);
      });
    });

    state.campaigns.forEach((campaign) => {
      (campaign.tags || []).forEach((tag) => {
        const record = getRecord(tag);
        if (record) record.campaigns.push(campaign);
      });
    });

    state.feedbackItems.forEach((item) => {
      (item.tags || []).forEach((tag) => {
        const record = getRecord(tag);
        if (record) record.feedback.push(item);
      });
    });

    const sortedRecords = Array.from(records.values()).sort((a, b) => {
      const usageDiff =
        b.targets.length + b.programs.length + b.funding.length + b.media.length + b.campaigns.length + b.feedback.length -
        (a.targets.length + a.programs.length + a.funding.length + a.media.length + a.campaigns.length + a.feedback.length);
      if (usageDiff !== 0) return usageDiff;
      return a.id.localeCompare(b.id);
    });
    tagRecordsCache = { revision: derivedDataRevision, records: sortedRecords };
    return sortedRecords;
  }

  function getFilteredTagRecords(records = getAllTagRecords()) {
    const query = String(state.tagSearch || "").toLowerCase();
    const usageFilter = state.tagUsageFilter || "all";

    return records.filter((record) => {
      const hasTargets = record.targets.length > 0;
      const hasPrograms = record.programs.length > 0;
      const hasFunding = record.funding.length > 0;
      const hasMedia = record.media.length > 0;
      const hasCampaigns = record.campaigns.length > 0;
      const hasFeedback = record.feedback.length > 0;
      const hasUsage = hasTargets || hasPrograms || hasFunding || hasMedia || hasCampaigns || hasFeedback;
      const hasDescription = Boolean(String(record.description || "").trim());

      if (usageFilter === "targets" && !hasTargets) return false;
      if (usageFilter === "programs" && !hasPrograms) return false;
      if (usageFilter === "funding" && !hasFunding) return false;
      if (usageFilter === "media" && !hasMedia) return false;
      if (usageFilter === "campaigns" && !hasCampaigns) return false;
      if (usageFilter === "feedback" && !hasFeedback) return false;
      if (usageFilter === "unused" && hasUsage) return false;
      if (usageFilter === "described" && !hasDescription) return false;
      if (usageFilter === "empty-description" && hasDescription) return false;

      if (!query) return true;
      const targetNames = record.targets.map((item) => item.platform).join(" ");
      const programNames = record.programs.map((item) => `${item.name} ${item.applicationName || ""}`).join(" ");
      const fundingNames = record.funding.map((item) => `${item.funder} ${item.opportunity || ""}`).join(" ");
      const mediaNames = record.media.map((media) => media.title).join(" ");
      const campaignNames = record.campaigns.map((campaign) => campaign.name).join(" ");
      const feedbackNames = record.feedback.map((item) => item.title).join(" ");
      const haystack = `${record.id} ${record.label} ${record.description} ${targetNames} ${programNames} ${fundingNames} ${mediaNames} ${campaignNames} ${feedbackNames}`.toLowerCase();
      return haystack.includes(query);
    });
  }

  function getAllTags() {
    return getAllTagRecords().map((record) => record.id);
  }

  function getExtraParamDef(id) {
    return extraParamsDefinition.find((p) => p.id === id) || null;
  }

  function tagDatalistId(suffix) {
    return `tagDatalist_${suffix}`;
  }

  function renderTagDatalist(id) {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement("datalist");
      el.id = id;
      document.body.appendChild(el);
    }
    el.innerHTML = getAllTags().map((t) => `<option value="${escapeAttribute(t)}">`).join("");
  }

  // --- Modal tags ---

  // --- Modal extra parameters pane ---



  // --- Facet filters (table) ---

  function renderCampaignTagFilters() {
    if (!elements.campaignFacetTagsList) return;
    renderTagDatalist(tagDatalistId("campaign"));
    if (elements.campaignFacetTagsInput) {
      elements.campaignFacetTagsInput.setAttribute("list", tagDatalistId("campaign"));
    }
    elements.campaignFacetTagsList.innerHTML = state.campaignTagFilter
      .map(
        (t) =>
          `<span class="tag-pill facet-pill" data-campaign-facet-tag="${escapeAttribute(t)}"${tagTooltipAttrs(t)}>${escapeHtml(t)}<button type="button" class="tag-remove" data-campaign-facet-tag-remove="${escapeAttribute(t)}" aria-label="${escapeAttribute(t("app.renderCampaignTagFilters.removeTagFilter"))}">${escapeHtml(t("app.renderCampaignTagFilters.text"))}</button></span>`,
      )
      .join("");
  }

  function addCampaignTagFilter(raw) {
    const tag = String(raw || "").trim().toLowerCase();
    if (!tag || state.campaignTagFilter.includes(tag)) return;
    state.campaignTagFilter.push(tag);
    state.campaignPage = 1;
    renderCampaignTagFilters();
    renderCampaigns();
  }

  function removeCampaignTagFilter(tag) {
    state.campaignTagFilter = state.campaignTagFilter.filter((t) => t !== tag);
    state.campaignPage = 1;
    renderCampaignTagFilters();
    renderCampaigns();
  }

  function renderFeedbackTagFilters() {
    if (!elements.feedbackFacetTagsList) return;
    renderTagDatalist(tagDatalistId("feedback"));
    if (elements.feedbackFacetTagsInput) {
      elements.feedbackFacetTagsInput.setAttribute("list", tagDatalistId("feedback"));
    }
    elements.feedbackFacetTagsList.innerHTML = state.feedbackTagFilter
      .map(
        (t) =>
          `<span class="tag-pill facet-pill" data-feedback-facet-tag="${escapeAttribute(t)}"${tagTooltipAttrs(t)}>${escapeHtml(t)}<button type="button" class="tag-remove" data-feedback-facet-tag-remove="${escapeAttribute(t)}" aria-label="${escapeAttribute(t("app.renderFeedbackTagFilters.removeTagFilter"))}">${escapeHtml(t("app.renderFeedbackTagFilters.text"))}</button></span>`,
      )
      .join("");
  }

  function addFeedbackTagFilter(raw) {
    const tag = String(raw || "").trim().toLowerCase();
    if (!tag || state.feedbackTagFilter.includes(tag)) return;
    state.feedbackTagFilter.push(tag);
    state.feedbackPage = 1;
    renderFeedbackTagFilters();
    renderFeedbackList();
  }

  function removeFeedbackTagFilter(tag) {
    state.feedbackTagFilter = state.feedbackTagFilter.filter((t) => t !== tag);
    state.feedbackPage = 1;
    renderFeedbackTagFilters();
    renderFeedbackList();
  }

  // --- Tooltip for extra params ---

  function formatExtraParamTooltip(param) {
    const defaults = (param.defaults || []).filter((d) => d !== "");
    return `
      <div class="tooltip-title">${escapeHtml(param.name)}</div>
      <div class="tooltip-section">
        <div class="tooltip-heading">${escapeHtml(t("app.formatExtraParamTooltip.whyTrackThis"))}</div>
        <div class="tooltip-body">${escapeHtml(param.description || t("app.formatExtraParamTooltip.noDescription"))}</div>
      </div>
      ${param.examples ? `<div class="tooltip-section"><div class="tooltip-heading">${escapeHtml(t("app.formatExtraParamTooltip.examples"))}</div><div class="tooltip-body">${escapeHtml(param.examples)}</div></div>` : ""}
      ${defaults.length ? `<div class="tooltip-section"><div class="tooltip-heading">${escapeHtml(t("app.formatExtraParamTooltip.defaultPossibilities"))}</div><div class="tooltip-body">${defaults.map(escapeHtml).join(", ")}</div></div>` : ""}
      <div class="tooltip-section"><div class="tooltip-heading">${escapeHtml(t("app.formatExtraParamTooltip.type"))}</div><div class="tooltip-body">${escapeHtml(param.type || "text")}</div></div>
    `;
  }

  function handleTooltipMouseOver(event) {
    const target = event.target.closest("[data-tooltip], [data-tooltip-type], [data-modal-extra-param]");
    if (!target) return;

    let html = "";
    let isWide = false;
    if (target.dataset.modalExtraParam) {
      const val = target.value || "";
      if (val.trim()) {
        const paramId = target.dataset.modalExtraParam;
        const paramDef = getExtraParamDef(paramId);
        const paramName = paramDef ? paramDef.name : paramId;
        html = `
          <div class="tooltip-title">${escapeHtml(paramName)}</div>
          <div class="tooltip-body" style="white-space: pre-wrap; word-break: break-word;">${escapeHtml(val)}</div>
        `;
        isWide = true;
      }
    } else if (target.dataset.tooltipType === "taxonomy") {
      const nodeId = target.dataset.nodeId || "";
      html = nodeId.startsWith("all:") ? formatAllTaxonomyTooltip(nodeId.slice(4)) : formatTaxonomyTooltip(nodeId);
    } else if (["category", "subcategory", "program-category", "program-subcategory", "funding-category", "funding-subcategory"].includes(target.dataset.tooltipType)) {
      // Pills and labels that name a node by its category and subcategory ids.
      const type = target.dataset.tooltipType;
      const nodeId = target.dataset.subcategoryId || target.dataset.categoryId || "";
      const section = type.startsWith("program") ? "po" : type.startsWith("funding") ? "fu" : "mk";
      html = !nodeId || nodeId === "all" ? formatAllTaxonomyTooltip(section) : formatTaxonomyTooltip(nodeId);
    } else if (target.dataset.tooltipType === "extraParam") {
      const param = getExtraParamDef(target.dataset.extraParamId);
      if (param) {
        html = formatExtraParamTooltip(param);
      }
    } else if (target.dataset.tooltipType === "tag") {
      const def = getTagDefinition(target.dataset.tagId);
      if (def) {
        html = formatTagTooltip(def);
      }
    } else {
      const text = target.dataset.tooltip;
      if (text) {
        html = `<div class="tooltip-simple">${escapeHtml(text)}</div>`;
      }
    }

    if (html) {
      showTooltip(target, html, isWide);
    }
  }

  function handleTooltipMouseOut(event) {
    const target = event.target.closest("[data-tooltip], [data-tooltip-type], [data-modal-extra-param]");
    if (target) {
      hideTooltip();
    }
  }

  function showTooltip(target, htmlContent, isWide = false) {
    let tooltip = document.getElementById("customTooltip");
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.id = "customTooltip";
      tooltip.className = "custom-tooltip";
      document.body.appendChild(tooltip);
    }

    tooltip.innerHTML = htmlContent;
    tooltip.classList.toggle("wide-tooltip", isWide);
    tooltip.classList.add("visible");

    const targetRect = target.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();

    let left = targetRect.left + (targetRect.width - tooltipRect.width) / 2;
    let top = targetRect.top - tooltipRect.height - 8;

    if (left < 12) {
      left = 12;
    } else if (left + tooltipRect.width > window.innerWidth - 12) {
      left = window.innerWidth - tooltipRect.width - 12;
    }

    if (top < 12) {
      top = targetRect.bottom + 8;
    }

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function hideTooltip() {
    const tooltip = document.getElementById("customTooltip");
    if (tooltip) {
      tooltip.classList.remove("visible");
    }
  }

  function formatAllTaxonomyTooltip(section) {
    if (section === "po") return formatAllProgramCategoriesTooltip();
    if (section === "fu") return formatAllFundingCategoriesTooltip();
    return formatAllCategoriesTooltip();
  }

  function formatAllCategoriesTooltip() {
    return `
      <div class="tooltip-title">${escapeHtml(t("app.formatAllCategoriesTooltip.allCategories"))}</div>
      <div class="tooltip-body">${escapeHtml(t("app.formatAllCategoriesTooltip.showsEveryActiveMarketingTarget"))}</div>
      <div class="tooltip-section" style="margin-top: 8px; font-size: 0.75rem; color: var(--muted); border-top: 1px solid rgba(255, 255, 255, 0.1); padding-top: 6px;">
        ${escapeHtml(t("app.formatAllCategoriesTooltip.hoverIndividualCategoryTabsOr"))}
      </div>
    `;
  }

  function formatAllProgramCategoriesTooltip() {
    return `
      <div class="tooltip-title">${escapeHtml(t("app.formatAllProgramCategoriesTooltip.allCategories"))}</div>
      <div class="tooltip-body">${escapeHtml(t("app.formatAllProgramCategoriesTooltip.showsEveryActiveProgramAnd"))}</div>
      <div class="tooltip-section" style="margin-top: 8px; font-size: 0.75rem; color: var(--muted); border-top: 1px solid rgba(255, 255, 255, 0.1); padding-top: 6px;">
        ${escapeHtml(t("app.formatAllProgramCategoriesTooltip.hoverIndividualCategoryTabsOr"))}
      </div>
    `;
  }

  function formatAllFundingCategoriesTooltip() {
    return `
      <div class="tooltip-title">${escapeHtml(t("app.formatAllFundingCategoriesTooltip.allCategories"))}</div>
      <div class="tooltip-body">${escapeHtml(t("app.formatAllFundingCategoriesTooltip.showsEveryActiveDealAnd"))}</div>
      <div class="tooltip-section" style="margin-top: 8px; font-size: 0.75rem; color: var(--muted); border-top: 1px solid rgba(255, 255, 255, 0.1); padding-top: 6px;">
        ${escapeHtml(t("app.formatAllFundingCategoriesTooltip.hoverIndividualCategoryTabsOr"))}
      </div>
    `;
  }

  function scheduleAutosave() {
    markDataChanged();
    automaticMergeNoticeVisible = false;
    if (autosaveTimer) {
      window.clearTimeout(autosaveTimer);
    }
    if (elements.saveStateLabel) {
      elements.saveStateLabel.classList.remove("synced", "conflict");
      elements.saveStateLabel.classList.add("saving");
      elements.saveStateLabel.innerHTML = `<span class="status-spinner"></span><span>${escapeHtml(t("app.scheduleAutosave.saving"))}</span>`;
      elements.saveStateLabel.setAttribute("data-tooltip", t("app.scheduleAutosave.savingChanges"));
    }
    autosaveTimer = window.setTimeout(() => {
      autosaveTimer = null;
      persist(t("app.scheduleAutosave.autosaved"));
    }, 250);
  }

  function flushAutosave() {
    if (!autosaveTimer) return;
    window.clearTimeout(autosaveTimer);
    autosaveTimer = null;
    persist(t("app.flushAutosave.autosaved"));
  }

  let activePersistPromise = null;
  let pendingPersistMessage = null;
  let persistRevision = 0;
  let focusSyncRequestRevision = 0;
  let deferredFocusSyncTimer = null;
  let pendingAutomaticMergeNotice = null;
  let automaticMergeNoticeVisible = false;
  let recordConflictReturnFocus = null;

  function buildRollbackOperations(operations) {
    const rollback = [];
    const reorderedSections = new Set();
    operations.forEach((operation) => {
      const previousRecords = Array.isArray(acknowledgedPersistedState?.[operation.section])
        ? acknowledgedPersistedState[operation.section]
        : [];
      if (operation.type === "upsert") {
        const previousIndex = previousRecords.findIndex((record) => String(record?.id || "") === operation.id);
        if (previousIndex === -1) {
          rollback.push({ type: "delete", section: operation.section, id: operation.id });
        } else {
          rollback.push({
            type: "upsert",
            section: operation.section,
            id: operation.id,
            value: previousRecords[previousIndex],
            position: previousIndex,
          });
        }
      } else if (operation.type === "delete") {
        const previousIndex = previousRecords.findIndex((record) => String(record?.id || "") === operation.id);
        if (previousIndex !== -1) {
          rollback.push({
            type: "upsert",
            section: operation.section,
            id: operation.id,
            value: previousRecords[previousIndex],
            position: previousIndex,
          });
        }
      } else if (operation.type === "reorder") {
        reorderedSections.add(operation.section);
      } else if (operation.type === "replaceSection") {
        rollback.push({
          type: "replaceSection",
          section: operation.section,
          value: acknowledgedPersistedState?.[operation.section] ?? null,
        });
      }
    });
    reorderedSections.forEach((section) => {
      rollback.push({
        type: "reorder",
        section,
        ids: (acknowledgedPersistedState?.[section] || []).map((record) => String(record.id)),
      });
    });
    return rollback;
  }

  function makeOutboxBatch(persistedState, operations) {
    return {
      mutationId: makeMutationId(),
      baseRevision: state.lastServerRevision || 0,
      // The startup revision this page had loaded when the edit was made. A
      // restore or import after it makes the server refuse the batch as
      // "restored" instead of replaying it over the restored data.
      knownRevision: state.lastServerRevision || 0,
      baseHash: state.lastServerFileHash || "",
      baseUpdatedAt: acknowledgedPersistedState?.updatedAt || "",
      updatedAt: persistedState.updatedAt,
      operations: clonePersistedState(operations),
      rollbackOperations: buildRollbackOperations(operations),
    };
  }

  function getOutboxRequest(batch) {
    return {
      protocolVersion: 2,
      mutationId: batch.mutationId,
      baseRevision: batch.baseRevision,
      baseHash: batch.baseHash,
      updatedAt: batch.updatedAt,
      // Stamps every history entry this save produces as coming from the
      // browser, so the timeline can tell an edit made here apart from one a
      // maintenance tool or the backfill wrote.
      origin: "ui",
      // Older cached batches have no knownRevision; their baseRevision is the
      // same number, taken at the same moment.
      knownRevision: Number.isFinite(Number(batch.knownRevision)) ? Number(batch.knownRevision) : Number(batch.baseRevision) || 0,
      operations: batch.operations,
    };
  }

  async function encodeJsonRequest(serialized) {
    if (serialized.length < 256 * 1024 || typeof CompressionStream !== "function") {
      return { body: serialized, encoding: "" };
    }
    try {
      const stream = new Blob([serialized], { type: "application/json" })
        .stream()
        .pipeThrough(new CompressionStream("gzip"));
      return { body: await new Response(stream).blob(), encoding: "gzip" };
    } catch (error) {
      return { body: serialized, encoding: "" };
    }
  }

  async function sendJsonMutation(url, method, payload, extraHeaders = {}) {
    const serialized = JSON.stringify(payload);
    const encoded = await encodeJsonRequest(serialized);
    const headers = { "Content-Type": "application/json", ...extraHeaders };
    if (encoded.encoding) headers["Content-Encoding"] = encoded.encoding;
    return fetch(url, { method, headers, body: encoded.body });
  }

  async function cacheCurrentState(outbox = pendingOutbox, options = {}) {
    // An acknowledgement changes only the sync bookkeeping, so it can skip
    // rewriting the multi-megabyte state record and reuse the state that was
    // already built for the diff.
    const currentState = options.stateUnchanged
      ? (options.trackerState || null)
      : (options.trackerState || buildPersistedState());
    await saveStateToLocalCache(
      currentState || acknowledgedPersistedState,
      null,
      state.lastServerFileHash,
      state.lastServerRevision,
      outbox,
      acknowledgedPersistedState,
      { stateUnchanged: options.stateUnchanged === true },
    );
    return currentState;
  }

  async function sendPendingOutboxBatch(message) {
    // Batches held back by a record conflict are skipped rather than blocking
    // the queue behind them. They wait for an explicit decision from the user,
    // and everything else must keep syncing normally in the meantime.
    const batchIndex = firstSendableOutboxIndex();
    if (batchIndex === -1) {
      if (hasBlockedConflictBatch()) {
        showRecordConflictNotification(state.recordConflicts || []);
        return false;
      }
      return true;
    }
    const batch = pendingOutbox[batchIndex];
    const missingBaseRevision = batch.operations.some((operation) => (
      operation.baseRevision === undefined || !Number.isFinite(Number(operation.baseRevision))
    ));
    if (missingBaseRevision) {
      state.conflictState = true;
      markSaved(t("app.sendPendingOutboxBatch.reloadRequiredBeforeSaving"));
      if (elements.saveStateLabel) {
        elements.saveStateLabel.classList.remove("syncing", "synced", "saving");
        elements.saveStateLabel.classList.add("conflict");
        elements.saveStateLabel.setAttribute(
          "data-tooltip",
          t("app.sendPendingOutboxBatch.thisCachedEditPredatesRecord"),
        );
      }
      return false;
    }
    ++persistRevision;
    const response = await sendJsonMutation(`${API_STATE_URL}/operations`, "PATCH", getOutboxRequest(batch), {
      "X-Last-File-Hash": batch.baseHash || "",
    });

    if (response.status === 409) {
      const payload = await response.json().catch(() => ({}));
      if (payload.error === "recordConflict") {
        return handleRecordConflict(batch, payload);
      }
      if (payload.error === "restored") {
        return handleRestoredConflict(payload);
      }
      if (payload.error === "reloadRequired") {
        state.conflictState = true;
        markSaved(t("app.sendPendingOutboxBatch.reloadRequiredBeforeSaving"));
        if (elements.saveStateLabel) {
          elements.saveStateLabel.classList.remove("syncing", "synced", "saving");
          elements.saveStateLabel.classList.add("conflict");
          elements.saveStateLabel.setAttribute(
            "data-tooltip",
            t("app.sendPendingOutboxBatch.thisTabUsesAnOlder"),
          );
        }
        return false;
      }
      state.conflictState = true;
      markSaved(SAVE_STATE.conflict);
      showConflictNotification();
      return false;
    }
    if (response.status === 413) {
      markSaved(t("app.sendPendingOutboxBatch.saveFailedUpdateIsToo"));
      return false;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const payload = await response.json();
    state.apiReady = true;
    state.filePath = payload.filePath || state.filePath;
    state.mediaDir = payload.mediaDir || state.mediaDir;
    // A save no longer returns a content hash, because producing one costs a
    // full re-read of the database on the server. Clearing it keeps the stale
    // value from being compared against a fresh one later; `revision` is the
    // authoritative sync token and is always present.
    state.lastServerFileHash = payload.fileHash || "";
    state.lastServerRevision = Number(payload.revision) || state.lastServerRevision;
    if (payload.revisionMap) acceptServerRevisionMap(payload.revisionMap);
    const acknowledged = applyOperationsToPersistedState(
      acknowledgedPersistedState,
      batch.operations,
      batch.updatedAt,
    );
    // The operations already name every record that moved, so the acknowledged
    // snapshot is advanced in place instead of being rebuilt from scratch.
    acknowledgedPersistedState = acknowledged;
    advanceAcknowledgedSnapshot(batch.operations, acknowledged);
    state.lastPersistedContentSignature = null;
    // Remove by identity: blocked batches may sit ahead of this one in the
    // queue, so the sent batch is not necessarily at index 0.
    removeOutboxBatch(batch);
    // Only the sync bookkeeping changed here; the state record was already
    // written before the request went out.
    await cacheCurrentState(pendingOutbox, { stateUnchanged: true });
    if (!hasSendableOutboxBatch() && !pendingPersistMessage) reportIdleSaveState(message);
    return true;
  }

  function operationKey(operation) {
    return `${operation?.section || ""}:${operation?.id || ""}`;
  }

  function findRollbackRecord(batch, operation) {
    const rollback = (batch.rollbackOperations || []).find(
      (entry) => operationKey(entry) === operationKey(operation),
    );
    return rollback?.type === "upsert" ? rollback.value : undefined;
  }

  async function readCurrentServerRecord(section, id) {
    const response = await fetch(
      `${API_STATE_URL}/records/${encodeURIComponent(section)}/${encodeURIComponent(id)}`,
      { cache: "no-store" },
    );
    if (response.status === 404) {
      const payload = await response.json().catch(() => ({}));
      return {
        record: undefined,
        recordRevision: null,
        revision: Number(payload.revision) || state.lastServerRevision,
      };
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    return {
      record: payload.ok ? payload.record : undefined,
      recordRevision: Number(payload.recordRevision) || 0,
      revision: Number(payload.revision) || state.lastServerRevision,
    };
  }

  function acceptServerRecordRevision(section, id, recordRevision, globalRevision) {
    if (!serverRevisionMap) serverRevisionMap = { revision: 0, sections: {}, records: {} };
    if (!serverRevisionMap.records) serverRevisionMap.records = {};
    if (!serverRevisionMap.records[section]) serverRevisionMap.records[section] = {};
    if (recordRevision === null || recordRevision === undefined) {
      delete serverRevisionMap.records[section][String(id)];
    } else {
      serverRevisionMap.records[section][String(id)] = Number(recordRevision) || 0;
    }
    serverRevisionMap.revision = Number(globalRevision) || serverRevisionMap.revision || 0;
    state.lastServerRevision = Number(globalRevision) || state.lastServerRevision;
  }

  function stampMergedRecord(record, base, local, server) {
    if (!record || typeof record !== "object" || Array.isArray(record)) return record;
    const carriesUpdatedAt = [base, local, server].some(
      (value) => value && Object.prototype.hasOwnProperty.call(value, "updatedAt"),
    );
    return carriesUpdatedAt ? { ...record, updatedAt: new Date().toISOString() } : record;
  }

  function readLiveRecord(section, id) {
    const collection = getLiveCollection(section);
    if (!Array.isArray(collection)) return undefined;
    return collection.find((record) => String(record?.id || "") === String(id));
  }

  function getLiveCollection(section) {
    if (section === "categories") return state.legacyCategories || [];
    if (section === "extraParamsDefinition") return extraParamsDefinition;
    if (section === "tagDefinitions") return tagDefinitions;
    return state[section];
  }

  function setLiveSection(section, value) {
    if (section === "categories") state.legacyCategories = value;
    else if (section === "extraParamsDefinition") extraParamsDefinition = value;
    else if (section === "tagDefinitions") tagDefinitions = value;
    else state[section] = value;
  }

  // Older tab caches may contain record-level conflicts created before field
  // details and automatic merging existed. Re-run those cached collisions
  // through the current comparison once at startup.
  async function reconcileLegacyBlockedConflicts() {
    const legacyBatches = pendingOutbox.filter((batch) => batch.blockedByConflict
      && (batch.conflicts || []).some((conflict) => !Array.isArray(conflict.overlapFields)));
    for (const batch of legacyBatches) {
      await handleRecordConflict(batch, {
        conflicts: batch.conflicts || [],
        revision: state.lastServerRevision,
        revisionMap: serverRevisionMap,
      });
    }
    state.recordConflicts = pendingOutbox
      .filter((batch) => batch.blockedByConflict)
      .flatMap((batch) => Array.isArray(batch.conflicts) ? batch.conflicts : []);
  }

  // A stale whole-record write gets a three-way comparison against the exact
  // base kept in the outbox and the current server record. Separate field edits
  // merge automatically. Only paths changed differently on both sides wait for
  // a decision.
  async function handleRecordConflict(batch, payload) {
    const conflicts = Array.isArray(payload.conflicts) ? payload.conflicts : [];
    if (payload.revisionMap) acceptServerRevisionMap(payload.revisionMap);
    state.lastServerRevision = Number(payload.revision) || state.lastServerRevision;

    const conflictKeys = new Set(conflicts.map(operationKey));
    const survivingOperations = batch.operations.filter(
      (operation) => !conflictKeys.has(operationKey(operation)),
    );
    removeOutboxBatch(batch);

    const conflictingOperations = batch.operations.filter(
      (operation) => conflictKeys.has(operationKey(operation)),
    );
    const autoMergedOperations = [];
    const unresolvedOperations = [];
    const unresolvedConflicts = [];
    const automaticMergeSummaries = [];

    for (const conflict of conflicts) {
      const operation = conflictingOperations.find((entry) => operationKey(entry) === operationKey(conflict));
      if (!operation || !conflict.id || !["upsert", "delete"].includes(operation.type)) {
        unresolvedOperations.push(...conflictingOperations.filter(
          (entry) => operationKey(entry) === operationKey(conflict),
        ));
        unresolvedConflicts.push({
          ...conflict,
          localFields: conflict.localFields || ["(record)"],
          serverFields: conflict.serverFields || ["(record)"],
          overlapFields: conflict.overlapFields || ["(record)"],
          fieldConflicts: conflict.fieldConflicts || [],
        });
        continue;
      }

      const baseRecord = findRollbackRecord(batch, operation);
      let serverRecord;
      try {
        const current = await readCurrentServerRecord(conflict.section, conflict.id);
        serverRecord = current.record;
        acceptServerRecordRevision(
          conflict.section,
          conflict.id,
          current.recordRevision,
          current.revision,
        );
      } catch (error) {
        unresolvedOperations.push(operation);
        unresolvedConflicts.push({
          ...conflict,
          localFields: conflict.localFields || ["(record)"],
          serverFields: conflict.serverFields || ["(record)"],
          overlapFields: conflict.overlapFields || ["(record)"],
          fieldConflicts: conflict.fieldConflicts || [],
        });
        continue;
      }

      // The user may keep editing while the failed PATCH and this GET are in
      // flight. Merge the latest live value, not the frozen operation that was
      // originally sent.
      const localRecord = readLiveRecord(conflict.section, conflict.id);
      let mergeResult;
      if (baseRecord === undefined && localRecord !== undefined && serverRecord !== undefined) {
        mergeResult = {
          canAutoMerge: false,
          localPaths: ["(record)"],
          serverPaths: ["(record)"],
          overlapPaths: ["(record)"],
          conflicts: [{
            path: "(record)",
            baseMissing: true,
            local: localRecord,
            server: serverRecord,
          }],
        };
      } else {
        mergeResult = window.RecordConflictMerge.mergeRecords(baseRecord, localRecord, serverRecord);
      }

      const detailedConflict = {
        ...conflict,
        localFields: mergeResult.localPaths,
        serverFields: mergeResult.serverPaths,
        overlapFields: mergeResult.overlapPaths,
        fieldConflicts: mergeResult.conflicts,
      };

      // The acknowledged snapshot follows the server. The live record stays on
      // the user's version until a merge or an explicit resolution updates it.
      applyAcknowledgedRecord(conflict.section, conflict.id, serverRecord);

      if (!mergeResult.canAutoMerge) {
        unresolvedOperations.push(operation);
        unresolvedConflicts.push(detailedConflict);
        continue;
      }

      const mergedRecord = stampMergedRecord(
        mergeResult.merged,
        baseRecord,
        localRecord,
        serverRecord,
      );
      applyLiveRecord(conflict.section, conflict.id, mergedRecord);
      automaticMergeSummaries.push(detailedConflict);

      if (!window.RecordConflictMerge.valuesEqual(mergedRecord, serverRecord)) {
        const retryOperation = {
          ...operation,
          type: mergedRecord === undefined ? "delete" : "upsert",
          value: mergedRecord,
          baseRevision: getRecordBaseRevision(conflict.section, conflict.id),
        };
        if (retryOperation.type === "upsert" && retryOperation.baseRevision === 0) {
          retryOperation.position = getLiveCollection(conflict.section).findIndex(
            (record) => String(record?.id || "") === String(conflict.id),
          );
        }
        autoMergedOperations.push(retryOperation);
      }
    }

    const retryOperations = [...survivingOperations, ...autoMergedOperations];
    if (retryOperations.length > 0) {
      const replacement = makeOutboxBatch({ updatedAt: batch.updatedAt }, retryOperations);
      pendingOutbox.unshift(replacement);
    }

    if (unresolvedOperations.length > 0) {
      const unresolvedKeys = new Set(unresolvedOperations.map(operationKey));
      pendingOutbox.push({
        ...batch,
        operations: unresolvedOperations,
        rollbackOperations: (batch.rollbackOperations || []).filter(
          (operation) => unresolvedKeys.has(operationKey(operation)),
        ),
        blockedByConflict: true,
        conflicts: clonePersistedState(unresolvedConflicts),
      });
    }

    state.recordConflicts = unresolvedConflicts;
    if (automaticMergeSummaries.length > 0) {
      pendingAutomaticMergeNotice = [
        ...(pendingAutomaticMergeNotice || []),
        ...automaticMergeSummaries,
      ];
      markDataChanged();
    }
    await cacheCurrentState(pendingOutbox);

    if (unresolvedConflicts.length > 0) showRecordConflictNotification(unresolvedConflicts);
    if (automaticMergeSummaries.length > 0) render();
    return retryOperations.length > 0 || unresolvedConflicts.length === 0;
  }

  // A restore or an import replaced this startup after these edits were made.
  // The server refused them and changed nothing. They are never resent on
  // their own: every queued batch is held as a conflict, the restored state is
  // loaded, and the held records keep showing the user's version until the
  // user picks "Keep mine" or "Use theirs" in the review.
  async function handleRestoredConflict(payload) {
    // Edits made while the refused request was in flight are not in a batch
    // yet; queue them too, so they are held with the rest instead of lost.
    const unsent = acknowledgedPatchSnapshot ? buildIncrementalOperations(buildPersistedState()) : [];
    if (unsent.length > 0) pendingOutbox.unshift(makeOutboxBatch(buildPersistedState(), unsent));

    const heldBatches = pendingOutbox.filter((batch) => !batch.blockedByConflict);
    const localVersions = new Map();
    heldBatches.flatMap((batch) => batch.operations).forEach((operation) => {
      const key = operationKey(operation);
      if (localVersions.has(key)) return;
      localVersions.set(key, operation.id
        ? { section: operation.section, id: operation.id, value: clonePersistedState(readLiveRecord(operation.section, operation.id) ?? null) }
        : { section: operation.section, id: "", value: clonePersistedState(getLiveCollection(operation.section) ?? buildPersistedState()[operation.section] ?? null) });
    });

    let serverState = null;
    try {
      const response = await fetch(API_STATE_URL, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const loaded = await response.json();
      serverState = loaded.state || {};
      state.lastServerFileHash = loaded.fileHash || "";
      state.lastServerRevision = Number(loaded.revision) || Number(payload.revision) || state.lastServerRevision;
      acceptServerRevisionMap(loaded.revisionMap);
      applyLoadedState(serverState);
      acceptAcknowledgedPersistedState(buildPersistedState());
    } catch (error) {
      // The state could not be read now. The edits stay held either way and
      // "Use theirs" reads the server again.
      state.lastServerRevision = Number(payload.revision) || state.lastServerRevision;
    }

    const serverValue = (entry) => {
      if (!serverState) return undefined;
      const section = serverState[entry.section];
      if (!entry.id) return section;
      return Array.isArray(section) ? section.find((record) => String(record?.id || "") === String(entry.id)) : undefined;
    };
    const conflictFor = (entry) => {
      const server = serverValue(entry);
      return {
        section: entry.section,
        ...(entry.id ? { id: entry.id } : {}),
        restored: true,
        localFields: ["(record)"],
        serverFields: ["(record)"],
        overlapFields: ["(record)"],
        fieldConflicts: [{
          path: "(record)",
          local: entry.value ?? undefined,
          server,
          localMissing: entry.value === null || entry.value === undefined,
          serverMissing: serverState !== null && (server === undefined || server === null),
        }],
      };
    };

    pendingOutbox = pendingOutbox.map((batch) => {
      if (batch.blockedByConflict) return batch;
      const keys = [...new Set(batch.operations.map(operationKey))];
      return {
        ...batch,
        blockedByConflict: true,
        restoredConflict: true,
        conflicts: clonePersistedState(keys.map((key) => conflictFor(localVersions.get(key)))),
      };
    });

    // The user's versions stay on screen for the held records only.
    if (serverState) {
      localVersions.forEach((entry) => {
        if (entry.id) applyLiveRecord(entry.section, entry.id, clonePersistedState(entry.value));
        else setLiveSection(entry.section, clonePersistedState(entry.value));
      });
    }
    state.recordConflicts = pendingOutbox
      .filter((batch) => batch.blockedByConflict)
      .flatMap((batch) => Array.isArray(batch.conflicts) ? batch.conflicts : []);
    markDataChanged();
    await cacheCurrentState(pendingOutbox);
    render();
    showRecordConflictNotification(state.recordConflicts);
    return false;
  }

  // Rebasing a held-back edit overwrites whatever the other writer put there,
  // so it only ever runs from an explicit choice in the conflict prompt. It is
  // deliberately not wired into persist(): autosave fires on any keystroke
  // anywhere in the app, and using that as consent would silently overwrite the
  // other version the moment the user typed in an unrelated field.
  function rebaseBlockedConflictBatches() {
    const batches = pendingOutbox.filter((entry) => entry.blockedByConflict);
    if (batches.length === 0) return false;

    const operationsByKey = new Map();
    batches.flatMap((batch) => batch.operations).forEach((operation) => {
      const liveCollection = getLiveCollection(operation.section);
      if (operation.id && Array.isArray(liveCollection)) {
        const liveIndex = liveCollection.findIndex(
          (record) => String(record?.id || "") === String(operation.id),
        );
        const liveRecord = liveIndex === -1 ? undefined : liveCollection[liveIndex];
        const baseRevision = getRecordBaseRevision(operation.section, operation.id);
        operationsByKey.set(operationKey(operation), liveRecord ? {
          type: "upsert",
          section: operation.section,
          id: operation.id,
          value: clonePersistedState(liveRecord),
          baseRevision,
          ...(baseRevision === 0 ? { position: liveIndex } : {}),
        } : {
          type: "delete",
          section: operation.section,
          id: operation.id,
          baseRevision: getRecordBaseRevision(operation.section, operation.id),
        });
      } else {
        const currentState = buildPersistedState();
        operationsByKey.set(operationKey(operation), operation.type === "reorder" ? {
          type: "reorder",
          section: operation.section,
          ids: (currentState[operation.section] || []).map((record) => String(record.id)),
          baseRevision: getSectionBaseRevision(operation.section),
        } : {
          type: "replaceSection",
          section: operation.section,
          value: clonePersistedState(currentState[operation.section]),
          baseRevision: getSectionBaseRevision(operation.section),
        });
      }
    });

    pendingOutbox = pendingOutbox.filter((batch) => !batch.blockedByConflict);
    const rebasedOperations = [...operationsByKey.values()];
    if (rebasedOperations.length > 0) {
      pendingOutbox.unshift(makeOutboxBatch(buildPersistedState(), rebasedOperations));
    }
    state.recordConflicts = [];
    return true;
  }

  function hasBlockedConflictBatch() {
    return pendingOutbox.some((batch) => batch.blockedByConflict);
  }

  function blockedRecordIds(section) {
    return new Set(pendingOutbox
      .filter((batch) => batch.blockedByConflict)
      .flatMap((batch) => batch.operations)
      .filter((operation) => operation.section === section && operation.id)
      .map((operation) => String(operation.id)));
  }

  function hasBlockedSectionOperation(section) {
    return pendingOutbox.some((batch) => batch.blockedByConflict
      && batch.operations.some((operation) => operation.section === section && !operation.id));
  }

  // Index of the first batch that may actually be sent. Blocked batches stay in
  // the outbox so they survive a reload, but they must never gate the ones
  // behind them.
  function firstSendableOutboxIndex() {
    return pendingOutbox.findIndex((batch) => !batch.blockedByConflict);
  }

  function hasSendableOutboxBatch() {
    return firstSendableOutboxIndex() !== -1;
  }

  function removeOutboxBatch(batch) {
    const index = pendingOutbox.indexOf(batch);
    if (index !== -1) pendingOutbox.splice(index, 1);
  }

  // What the status bar should say once there is nothing left to send. An
  // unresolved conflict outranks "Synced": the user still has a decision to
  // make, and every other edit really has been saved.
  function reportIdleSaveState(message) {
    if (hasBlockedConflictBatch()) {
      showRecordConflictNotification(state.recordConflicts || []);
      return;
    }
    if (pendingAutomaticMergeNotice?.length) {
      showAutomaticMergeNotification(pendingAutomaticMergeNotice);
      pendingAutomaticMergeNotice = null;
      automaticMergeNoticeVisible = true;
      return;
    }
    if (automaticMergeNoticeVisible) {
      automaticMergeNoticeVisible = false;
      return;
    }
    markSaved(message);
  }

  function describeRecordConflicts(conflicts) {
    if (conflicts.length > 0 && conflicts.every((conflict) => conflict.restored)) {
      return t("sync.restoredConflicts", { count: conflicts.length });
    }
    const fieldCount = conflicts.reduce(
      (total, conflict) => total + new Set(conflict.overlapFields || []).size,
      0,
    );
    if (fieldCount === 1) return t("app.describeRecordConflicts.1FieldConflict");
    if (fieldCount > 1) return t("app.describeRecordConflicts.fieldConflicts", { fieldCount });
    if (conflicts.length === 1) return t("app.describeRecordConflicts.1RecordConflict");
    return t("app.describeRecordConflicts.recordConflicts", { length: conflicts.length });
  }

  function formatConflictField(path) {
    if (!path || path === "(record)") return t("app.formatConflictField.wholeRecord");
    return path.split(".").map((part) => formatGlobalSearchFieldLabel(part)).join(" / ");
  }

  function uniqueConflictFields(conflicts, key) {
    return [...new Set(conflicts.flatMap((conflict) => conflict[key] || []))];
  }

  function showAutomaticMergeNotification(merges) {
    if (!elements.saveStateLabel) return;
    const serverFields = uniqueConflictFields(merges, "serverFields").map(formatConflictField);
    const localFields = uniqueConflictFields(merges, "localFields").map(formatConflictField);
    elements.saveStateLabel.classList.remove("syncing", "conflict", "saving");
    elements.saveStateLabel.classList.add("synced");
    elements.saveStateLabel.textContent = merges.length === 1
      ? t("app.showAutomaticMergeNotification.mergedConcurrentEdits")
      : t("app.showAutomaticMergeNotification.mergedEditsToRecords", { length: merges.length });
    elements.saveStateLabel.setAttribute(
      "data-tooltip",
      t("app.showAutomaticMergeNotification.tooltip", { server: serverFields.join(", ") || t("app.showAutomaticMergeNotification.none"), local: localFields.join(", ") || t("app.showAutomaticMergeNotification.none") }),
    );
  }

  function acceptServerRevisionMap(revisionMap) {
    if (!revisionMap || typeof revisionMap !== "object") return;
    serverRevisionMap = revisionMap;
  }

  // The revision each record was last written at on the server. An edit is sent
  // with the revision of the record it is based on, which is what lets the
  // server reject only genuine same-record collisions.
  function getRecordBaseRevision(section, id) {
    const sectionRecords = serverRevisionMap?.records?.[section];
    if (!serverRevisionMap) return undefined;
    if (!sectionRecords) return 0;
    const revision = sectionRecords[String(id)];
    return revision === undefined ? 0 : Number(revision);
  }

  function getSectionBaseRevision(section) {
    if (!serverRevisionMap) return undefined;
    const revision = serverRevisionMap?.sections?.[section];
    return revision === undefined ? 0 : Number(revision);
  }

  async function persist(message = t("app.persist.saved")) {
    markDataChanged();
    // Shared data goes its own way, a moment after the last change.
    globalChannel?.schedule();
    if (state.conflictState) {
      markSaved(SAVE_STATE.conflict);
      return false;
    }
    if (activePersistPromise) {
      pendingPersistMessage = message;
      return activePersistPromise;
    }

    activePersistPromise = (async () => {
      try {
        let saveMessage = message;
        // The state and its diff are built once per round trip and reused, so
        // one edit no longer rebuilds and re-stringifies the whole state four
        // times over.
        let persistedState = buildPersistedState();
        let operations = hasSendableOutboxBatch() ? null : buildIncrementalOperations(persistedState);
        while (true) {
          // Held as a reference, not a signature. Only an overlapping focus
          // sync ever compares it, and stringifying the whole state on every
          // save just to support that case was pure overhead.
          inFlightPersistedState = persistedState;
          if (!hasSendableOutboxBatch()) {
            if (operations.length === 0) {
              await cacheCurrentState(pendingOutbox, { trackerState: persistedState });
              reportIdleSaveState(saveMessage);
              return true;
            }
            // New work goes in front of anything held back by a conflict, so a
            // pending decision never delays an unrelated edit.
            pendingOutbox.unshift(makeOutboxBatch(persistedState, operations));
          }

          await cacheCurrentState(pendingOutbox, { trackerState: persistedState });
          if (elements.saveStateLabel) {
            automaticMergeNoticeVisible = false;
            elements.saveStateLabel.classList.remove("synced", "conflict", "syncing");
            elements.saveStateLabel.classList.add("saving");
            elements.saveStateLabel.innerHTML = `<span class="status-spinner"></span><span>${escapeHtml(t("app.persist.saving"))}</span>`;
            elements.saveStateLabel.setAttribute("data-tooltip", t("app.persist.savingChanges"));
          }
          const dataRevisionAtSend = derivedDataRevision;
          const saved = await sendPendingOutboxBatch(saveMessage);
          if (!saved) return false;

          // Edits can happen while the previous request is in flight or while
          // an older offline batch is being replayed, and those must never be
          // stranded. derivedDataRevision changes on every data mutation, so
          // when it has not moved there is provably nothing new to diff and the
          // full re-diff of every record can be skipped.
          if (derivedDataRevision === dataRevisionAtSend && !hasSendableOutboxBatch()) {
            pendingPersistMessage = null;
            reportIdleSaveState(saveMessage);
            return true;
          }
          persistedState = buildPersistedState();
          operations = buildIncrementalOperations(persistedState);
          if (operations.length === 0 && !hasSendableOutboxBatch()) {
            pendingPersistMessage = null;
            reportIdleSaveState(saveMessage);
            return true;
          }
          saveMessage = pendingPersistMessage || saveMessage;
          pendingPersistMessage = null;
        }
      } catch (error) {
        state.apiReady = false;
        try {
          await cacheCurrentState();
          markSaved(SAVE_STATE.local);
        } catch (cacheError) {
          markSaved(t("app.persist.saveFailedBrowserStorageUnavailable"));
        }
        return false;
      } finally {
        inFlightPersistedState = null;
        state.inFlightContentSignature = null;
        activePersistPromise = null;
        if (pendingPersistMessage && !state.conflictState) {
          const nextMsg = pendingPersistMessage;
          pendingPersistMessage = null;
          persist(nextMsg);
        }
      }
    })();

    return activePersistPromise;
  }

  function isModalOpen(element) {
    return !!element && !element.hidden;
  }

  function hasOpenEditorModal() {
    return isModalOpen(elements.mediaDocumentModal) || Boolean(RecordWindow.state());
  }


  function scheduleDeferredFocusSync() {
    if (deferredFocusSyncTimer) return;
    deferredFocusSyncTimer = window.setTimeout(() => {
      deferredFocusSyncTimer = null;
      handleWindowFocus();
    }, 750);
  }

  async function handleWindowFocus() {
    refreshGlobalData();
    if (state.conflictState || activePersistPromise) return;
    if (hasBlockedConflictBatch()) {
      showRecordConflictNotification(state.recordConflicts || []);
      return;
    }
    if (pendingOutbox.length > 0) {
      state.apiReady = true;
      const synced = await persist(SAVE_STATE.synced);
      if (synced && pendingOutbox.length === 0) {
        await loadStateFromServer({ forceSnapshot: true });
      }
      return;
    }

    const thisFocusSyncRequestRevision = ++focusSyncRequestRevision;
    const persistRevisionAtRequest = persistRevision;

    try {
      // Validate on the revision counter: the server changes it exactly when
      // the content changes, and matching it costs no hashing on either side.
      const requestHeaders = state.lastServerRevision && serverRevisionMap
        ? { "If-None-Match": `W/"rev-${state.lastServerRevision}"` }
        : {};
      const response = await fetch(API_STATE_URL, { cache: "no-store", headers: requestHeaders });
      if (response.status === 304) {
        state.apiReady = true;
        state.lastServerRevision = Number(response.headers.get("X-State-Revision")) || state.lastServerRevision;
        await cacheCurrentState(pendingOutbox, { stateUnchanged: true });
        if (state.recordConflicts?.length) showRecordConflictNotification(state.recordConflicts);
        else if (pendingOutbox.length) markSaved(SAVE_STATE.local);
        else markSaved(SAVE_STATE.synced);
        return;
      }
      if (!response.ok) return;
      const payload = await response.json();
      state.apiReady = true;
      // A focus request may overlap an autosave. If a save started after this
      // request, its response can contain an older file hash. Never let that
      // stale response roll the client hash back and cause the next save to
      // report a false conflict.
      if (
        thisFocusSyncRequestRevision !== focusSyncRequestRevision
        || persistRevisionAtRequest !== persistRevision
      ) return;
      const trackerState = payload.state || null;
      if (payload.fileHash && payload.fileHash !== state.lastServerFileHash) {
        const serverSignature = trackerState ? getPersistedContentSignature(trackerState) : null;
        const currentClientSignature = getPersistedContentSignature(buildPersistedState());

        const isContentIdentical = serverSignature && (
          serverSignature === currentClientSignature ||
          serverSignature === getLastPersistedContentSignature() ||
          serverSignature === getInFlightContentSignature()
        );

        if (isContentIdentical) {
          state.lastServerRevision = Number(payload.revision) || state.lastServerRevision;
          acceptServerRevisionMap(payload.revisionMap);
          state.lastServerFileHash = payload.fileHash;
          if (serverSignature) {
            state.lastPersistedContentSignature = serverSignature;
            await saveStateToLocalCache(
              trackerState,
              null,
              payload.fileHash,
              state.lastServerRevision,
              pendingOutbox,
              acknowledgedPersistedState,
            );
          }
          if (state.recordConflicts?.length) showRecordConflictNotification(state.recordConflicts);
          else if (!pendingOutbox.length) markSaved(SAVE_STATE.synced);
          return;
        }

        const activeInput = document.activeElement;
        const isUserTyping = activeInput && (activeInput.tagName === "INPUT" || activeInput.tagName === "TEXTAREA" || activeInput.tagName === "SELECT");
        const modalOpen = hasOpenEditorModal();
        const hasLocalUnpersistedChanges = currentClientSignature !== getLastPersistedContentSignature();

        if (!hasLocalUnpersistedChanges) {
          if (!isUserTyping && !modalOpen) {
            markSyncing(t("app.handleWindowFocus.syncingData"));
            applyLoadedState(trackerState);
            state.lastServerRevision = Number(payload.revision) || state.lastServerRevision;
            acceptServerRevisionMap(payload.revisionMap);
            state.lastServerFileHash = payload.fileHash;
            acceptAcknowledgedPersistedState(buildPersistedState());
            await saveStateToLocalCache(trackerState, null, state.lastServerFileHash);
            render();
            markSaved(SAVE_STATE.synced);
          } else {
            markSyncing(t("app.handleWindowFocus.updateWaitingForEditor"));
            scheduleDeferredFocusSync();
          }
          return;
        }

        // There are local edits and the server has moved on. Both can be true
        // without being in conflict: saves carry a per-record base revision, so
        // the server takes every edit that does not touch a record someone else
        // changed and reports only the ones that genuinely collide. Flush the
        // local edits and let that mechanism decide, instead of blocking the
        // tab on the assumption that any concurrent change is a conflict.
        await persist(SAVE_STATE.synced);
      }
    } catch (e) {
      state.apiReady = false;
    }
  }

  // True field overlaps stay in the status bar until the user reviews them.
  // Editing remains enabled and every unrelated edit continues to sync.
  function showRecordConflictNotification(conflicts) {
    if (!elements.saveStateLabel) return;
    const list = Array.isArray(conflicts) ? conflicts : [];
    const names = list
      .map((conflict) => (conflict.id ? `${conflict.section}/${conflict.id}` : conflict.section))
      .join(", ");
    const serverFields = uniqueConflictFields(list, "serverFields").map(formatConflictField);
    const localFields = uniqueConflictFields(list, "localFields").map(formatConflictField);
    const overlapFields = uniqueConflictFields(list, "overlapFields").map(formatConflictField);
    elements.saveStateLabel.classList.remove("syncing", "synced", "saving");
    elements.saveStateLabel.classList.add("conflict");
    elements.saveStateLabel.innerHTML = `<span>${escapeHtml(describeRecordConflicts(list))}</span>`
      + `<button type="button" class="save-state-action" data-conflict-action="review">${escapeHtml(t("app.showRecordConflictNotification.review"))}</button>`;
    elements.saveStateLabel.setAttribute(
      "data-tooltip",
      list.length > 0 && list.every((conflict) => conflict.restored)
        ? t("sync.restoredTooltip", { records: names })
        : t("app.showRecordConflictNotification.tooltip", {
          records: names,
          server: serverFields.join(", ") || t("app.showRecordConflictNotification.unknownFields"),
          local: localFields.join(", ") || t("app.showRecordConflictNotification.unknownFields"),
          both: overlapFields.join(", ") || t("app.showRecordConflictNotification.theSameRecord"),
        }),
    );
  }

  function formatConflictValue(value, missing) {
    if (missing) return t("app.formatConflictValue.removed");
    if (typeof value === "string") return value || t("app.formatConflictValue.empty");
    if (value === undefined) return t("app.formatConflictValue.notAvailable");
    return JSON.stringify(value, null, 2);
  }

  function renderRecordConflictReview() {
    if (!elements.recordConflictReview) return;
    const conflicts = Array.isArray(state.recordConflicts) ? state.recordConflicts : [];
    if (elements.useTheirsConflictButton) {
      elements.useTheirsConflictButton.textContent = conflicts.length > 1 ? t("app.renderRecordConflictReview.useAllServerVersions") : t("app.renderRecordConflictReview.useTheirs");
    }
    if (elements.keepMineConflictButton) {
      elements.keepMineConflictButton.textContent = conflicts.length > 1 ? t("app.renderRecordConflictReview.keepAllMyVersions") : t("app.renderRecordConflictReview.keepMine");
    }
    elements.recordConflictReview.innerHTML = conflicts.map((conflict) => {
      const localFields = (conflict.localFields || []).map(formatConflictField).join(", ") || t("app.renderRecordConflictReview.unknown");
      const serverFields = (conflict.serverFields || []).map(formatConflictField).join(", ") || t("app.renderRecordConflictReview.unknown");
      const overlapFields = (conflict.overlapFields || []).map(formatConflictField).join(", ") || t("app.renderRecordConflictReview.wholeRecord");
      const comparisons = Array.isArray(conflict.fieldConflicts) && conflict.fieldConflicts.length
        ? conflict.fieldConflicts
        : [{ path: "(record)", local: undefined, server: undefined }];
      return `<section class="record-conflict-record">
        <div class="record-conflict-record-header">
          <h3>${escapeHtml(conflict.id ? `${conflict.section}/${conflict.id}` : conflict.section)}</h3>
          ${conflict.restored ? `<p class="record-conflict-note">${escapeHtml(t("sync.restoredRecord"))}</p>` : ""}
        </div>
        <div class="record-conflict-summary">
          <span><strong>${escapeHtml(t("app.renderRecordConflictReview.changedElsewhere"))}</strong> ${escapeHtml(serverFields)}</span>
          <span><strong>${escapeHtml(t("app.renderRecordConflictReview.yourChanges"))}</strong> ${escapeHtml(localFields)}</span>
          <span><strong>${escapeHtml(t("app.renderRecordConflictReview.bothChanged"))}</strong> ${escapeHtml(overlapFields)}</span>
        </div>
        ${comparisons.map((entry) => `<div class="record-conflict-field">
          <p class="record-conflict-field-name">${escapeHtml(formatConflictField(entry.path))}</p>
          <div class="record-conflict-comparison">
            <div class="record-conflict-version">
              <span class="record-conflict-version-label">${escapeHtml(t("app.renderRecordConflictReview.changedElsewhere2"))}</span>
              <pre class="record-conflict-value">${escapeHtml(formatConflictValue(entry.server, entry.serverMissing))}</pre>
            </div>
            <div class="record-conflict-version">
              <span class="record-conflict-version-label">${escapeHtml(t("app.renderRecordConflictReview.yourVersion"))}</span>
              <pre class="record-conflict-value">${escapeHtml(formatConflictValue(entry.local, entry.localMissing))}</pre>
            </div>
          </div>
        </div>`).join("")}
      </section>`;
    }).join("");
  }

  function openRecordConflictModal() {
    if (!elements.recordConflictModal || !hasBlockedConflictBatch()) return;
    renderRecordConflictReview();
    recordConflictReturnFocus = document.activeElement;
    elements.recordConflictModal.hidden = false;
    window.requestAnimationFrame(() => {
      elements.recordConflictModal.classList.add("open");
      elements.closeRecordConflictModal?.focus();
    });
  }

  function closeRecordConflictModal() {
    if (!elements.recordConflictModal) return;
    elements.recordConflictModal.classList.remove("open");
    window.setTimeout(() => {
      if (!elements.recordConflictModal.classList.contains("open")) {
        elements.recordConflictModal.hidden = true;
        if (recordConflictReturnFocus?.isConnected) recordConflictReturnFocus.focus();
        else elements.saveStateLabel?.focus();
        recordConflictReturnFocus = null;
      }
    }, 300);
  }

  // "Keep mine": rebase the held-back edits onto the server's current revision
  // and send them, overwriting whatever the other writer stored.
  async function resolveRecordConflictsKeepingMine() {
    if (!hasBlockedConflictBatch()) return;
    const conflicts = clonePersistedState(state.recordConflicts || []);
    const names = conflicts
      .map((conflict) => (conflict.id ? `${conflict.section}/${conflict.id}` : conflict.section))
      .join("\n  ");
    const confirmed = window.confirm(t("app.resolveRecordConflictsKeepingMine.confirm", { records: names }));
    if (!confirmed) return;
    closeRecordConflictModal();
    rebaseBlockedConflictBatches();
    await persist(SAVE_STATE.synced);
  }

  // "Use theirs": drop the held-back edits and take the server's copy of each
  // conflicting record, leaving every other local edit untouched.
  async function resolveRecordConflictsUsingTheirs() {
    if (!hasBlockedConflictBatch()) return;
    const conflicts = clonePersistedState(state.recordConflicts || []);
    const names = conflicts
      .map((conflict) => (conflict.id ? `${conflict.section}/${conflict.id}` : conflict.section))
      .join("\n  ");
    const confirmed = window.confirm(t("app.resolveRecordConflictsUsingTheirs.confirm", { records: names }));
    if (!confirmed) return;

    const resolvedKeys = new Set();
    let serverStatePromise = null;
    for (const conflict of conflicts) {
      try {
        if (!conflict.id) {
          serverStatePromise ||= fetch(API_STATE_URL, { cache: "no-store" }).then(async (response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
          });
          const payload = await serverStatePromise;
          state.lastServerRevision = Number(payload.revision) || state.lastServerRevision;
          acceptServerRevisionMap(payload.revisionMap);
          applyServerSection(conflict.section, payload.state?.[conflict.section]);
          resolvedKeys.add(operationKey(conflict));
          continue;
        }
        const current = await readCurrentServerRecord(conflict.section, conflict.id);
        acceptServerRecordRevision(
          conflict.section,
          conflict.id,
          current.recordRevision,
          current.revision,
        );
        applyServerRecord(conflict.section, conflict.id, current.record);
        resolvedKeys.add(operationKey(conflict));
      } catch (error) {
        // Keep this conflict and its local edit until the server can be read.
      }
    }
    pendingOutbox = pendingOutbox.flatMap((batch) => {
      if (!batch.blockedByConflict) return [batch];
      const operations = batch.operations.filter((operation) => !resolvedKeys.has(operationKey(operation)));
      if (operations.length === 0) return [];
      const remainingKeys = new Set(operations.map(operationKey));
      return [{
        ...batch,
        operations,
        rollbackOperations: (batch.rollbackOperations || []).filter(
          (operation) => remainingKeys.has(operationKey(operation)),
        ),
        conflicts: (batch.conflicts || []).filter(
          (conflict) => remainingKeys.has(operationKey(conflict)),
        ),
      }];
    });
    state.recordConflicts = conflicts.filter((conflict) => !resolvedKeys.has(operationKey(conflict)));
    if (state.recordConflicts.length === 0) closeRecordConflictModal();
    else renderRecordConflictReview();
    markDataChanged();
    render();
    await persist(SAVE_STATE.synced);
  }

  function applyLiveRecord(section, id, record) {
    const collection = getLiveCollection(section);
    if (!Array.isArray(collection)) return;
    const index = collection.findIndex((entry) => String(entry?.id || "") === String(id));
    if (record === null || record === undefined) {
      if (index !== -1) collection.splice(index, 1);
    } else if (index === -1) {
      collection.push(record);
    } else {
      collection[index] = record;
    }
  }

  function applyAcknowledgedRecord(section, id, record) {
    if (!acknowledgedPersistedState || !Array.isArray(acknowledgedPersistedState[section])) return;
    const acknowledgedCollection = acknowledgedPersistedState[section].slice();
    const acknowledgedIndex = acknowledgedCollection.findIndex(
      (entry) => String(entry?.id || "") === String(id),
    );
    if (record === null || record === undefined) {
      if (acknowledgedIndex !== -1) acknowledgedCollection.splice(acknowledgedIndex, 1);
    } else if (acknowledgedIndex === -1) {
      acknowledgedCollection.push(clonePersistedState(record));
    } else {
      acknowledgedCollection[acknowledgedIndex] = clonePersistedState(record);
    }
    acknowledgedPersistedState = {
      ...acknowledgedPersistedState,
      [section]: acknowledgedCollection,
    };
    const snapshotCollection = acknowledgedPatchSnapshot?.collections?.[section];
    if (snapshotCollection) {
      if (record === null || record === undefined) snapshotCollection.signatures.delete(String(id));
      else snapshotCollection.signatures.set(String(id), JSON.stringify(record));
      snapshotCollection.ids = acknowledgedCollection.map((entry) => String(entry?.id || ""));
    }
    state.lastPersistedContentSignature = null;
  }

  // Drop the server's copy into both snapshots so it is not immediately sent
  // back as a local change.
  function applyServerRecord(section, id, record) {
    applyLiveRecord(section, id, record);
    applyAcknowledgedRecord(section, id, record);
  }

  function applyServerSection(section, value) {
    const copy = clonePersistedState(value);
    setLiveSection(section, copy);
    acknowledgedPersistedState = {
      ...(acknowledgedPersistedState || {}),
      [section]: clonePersistedState(value),
    };
    acknowledgedPatchSnapshot = buildPatchSnapshot(acknowledgedPersistedState);
    state.lastPersistedContentSignature = null;
  }

  function showConflictNotification() {
    if (elements.saveStateLabel) {
      elements.saveStateLabel.classList.remove("syncing", "synced", "saving");
      elements.saveStateLabel.classList.add("conflict");
      elements.saveStateLabel.textContent = t("app.showConflictNotification.conflictReload");
      elements.saveStateLabel.setAttribute("data-tooltip", t("app.showConflictNotification.theDatabaseHasBeenUpdated"));
    }
    window.alert(t("app.showConflictNotification.alert"));
  }

  function buildPersistedState() {
    return {
      name: t("app.buildPersistedState.startupTracker"),
      version: 3,
      timeZone: getTimeZone(),
      updatedAt: new Date().toISOString(),
      ...(state.legacyCategories ? { categories: state.legacyCategories } : {}),
      ...(state.enabledTaxonomy ? { enabledTaxonomy: state.enabledTaxonomy } : {}),
      links: state.links,
      extraParamsDefinition: extraParamsDefinition,
      // Research links ticked "Shared" are saved with the shared data.
      dailyLinks: state.dailyLinks.filter((link) => !link.shared),
      feedbackItems: state.feedbackItems,
      programs: state.programs,
      funding: state.funding,
      fundingRounds: state.fundingRounds,
      deletedPrograms: state.deletedPrograms,
      deletedFunding: state.deletedFunding,
      deletedMediaItems: state.deletedMediaItems,
      deletedFeedbackItems: state.deletedFeedbackItems,
      deletedDailyLinks: state.deletedDailyLinks.filter((link) => !link.shared),
      ...(state.profile ? { profile: state.profile } : {}),
      ...(state.companyProfile ? { companyProfile: state.companyProfile } : {}),
      companySteps: state.companySteps,
      companyObligations: state.companyObligations,
      companyDeadlines: state.companyDeadlines,
      companyExpenses: state.companyExpenses,
      deletedCompanySteps: state.deletedCompanySteps,
      deletedCompanyObligations: state.deletedCompanyObligations,
      deletedCompanyExpenses: state.deletedCompanyExpenses,
      mediaItems: buildPersistedMediaItems(),
      items: state.items.map((item) => ({ ...item, extraParams: filterRetiredExtraParams(item.extraParams, RETIRED_TARGET_EXTRA_PARAM_IDS) })),
      deletedItems: state.deletedItems.map((item) => ({ ...item, extraParams: filterRetiredExtraParams(item.extraParams, RETIRED_TARGET_EXTRA_PARAM_IDS) })),
    };
  }

  let acknowledgedPersistedState = null;
  let acknowledgedPatchSnapshot = null;
  let pendingOutbox = [];
  // Per-record revisions as last reported by the server, used to stamp each
  // outgoing operation with the version of the record it was based on.
  let serverRevisionMap = null;
  // The state a save is currently sending, kept so an overlapping focus sync
  // can compare against it without a signature being computed up front.
  let inFlightPersistedState = null;

  function clonePersistedState(value) {
    return globalThis.structuredClone
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));
  }

  function buildPatchSnapshot(trackerState) {
    const collections = {};
    PATCHABLE_RECORD_COLLECTIONS.forEach((section) => {
      const records = Array.isArray(trackerState?.[section]) ? trackerState[section] : [];
      const signatures = new Map();
      const ids = [];
      records.forEach((record) => {
        const id = String(record?.id || "");
        if (!id || signatures.has(id)) {
          throw new Error(t("app.buildPatchSnapshot.cannotIncrementallySaveEveryRecord", { section }));
        }
        ids.push(id);
        signatures.set(id, JSON.stringify(record));
      });
      collections[section] = { ids, signatures };
    });

    const sections = new Map();
    Object.entries(trackerState || {}).forEach(([section, value]) => {
      if (section === "updatedAt" || PATCHABLE_RECORD_COLLECTIONS.includes(section)) return;
      sections.set(section, JSON.stringify(value));
    });
    return { collections, sections };
  }

  function acceptAcknowledgedPersistedState(trackerState) {
    acknowledgedPersistedState = clonePersistedState(trackerState);
    acknowledgedPatchSnapshot = buildPatchSnapshot(acknowledgedPersistedState);
    state.lastPersistedContentSignature = null;
    if (pendingLinkMigration) applyPendingLinkMigration();
  }

  // Old link fields read into links on load (applyLoadedState): forget the
  // saved copies of those links and records so the next save writes them.
  function applyPendingLinkMigration() {
    const migration = pendingLinkMigration;
    pendingLinkMigration = null;
    const forget = (section, id) => acknowledgedPatchSnapshot.collections[section]?.signatures.delete(String(id));
    migration.links.forEach((id) => forget("links", id));
    migration.records.forEach(({ section, id }) => forget(section, id));
    scheduleAutosave();
  }

  // Fold an already-computed operation list into the acknowledged snapshot.
  // Re-deriving the snapshot from scratch means stringifying all ~1,100 records
  // again; the operations already say precisely which ones moved, so only those
  // signatures need recomputing.
  function advanceAcknowledgedSnapshot(operations, trackerState) {
    if (!acknowledgedPatchSnapshot) {
      acknowledgedPatchSnapshot = buildPatchSnapshot(trackerState);
      return;
    }

    const touchedCollections = new Set();
    operations.forEach((operation) => {
      const collection = acknowledgedPatchSnapshot.collections[operation.section];
      if (operation.type === "upsert" && collection) {
        collection.signatures.set(operation.id, JSON.stringify(operation.value));
        touchedCollections.add(operation.section);
        return;
      }
      if (operation.type === "delete" && collection) {
        collection.signatures.delete(operation.id);
        touchedCollections.add(operation.section);
        return;
      }
      if (operation.type === "reorder" && collection) {
        collection.ids = operation.ids.slice();
        return;
      }
      if (operation.type === "replaceSection") {
        if (PATCHABLE_RECORD_COLLECTIONS.includes(operation.section)) {
          const records = Array.isArray(operation.value) ? operation.value : [];
          const signatures = new Map();
          const ids = [];
          records.forEach((record) => {
            const id = String(record?.id || "");
            ids.push(id);
            signatures.set(id, JSON.stringify(record));
          });
          acknowledgedPatchSnapshot.collections[operation.section] = { ids, signatures };
          return;
        }
        if (operation.value === null || operation.value === undefined) {
          acknowledgedPatchSnapshot.sections.delete(operation.section);
        } else {
          acknowledgedPatchSnapshot.sections.set(operation.section, JSON.stringify(operation.value));
        }
      }
    });

    // Upserts and deletes change collection membership and ordering, so the id
    // list has to be re-read from the state those operations were built from.
    touchedCollections.forEach((section) => {
      const collection = acknowledgedPatchSnapshot.collections[section];
      const records = Array.isArray(trackerState?.[section]) ? trackerState[section] : [];
      collection.ids = records.map((record) => String(record?.id || ""));
    });
  }

  function buildIncrementalOperations(trackerState) {
    if (!acknowledgedPatchSnapshot) {
      return Object.entries(trackerState || {})
        .filter(([section]) => section !== "updatedAt")
        .map(([section, value]) => ({
          type: "replaceSection",
          section,
          value,
          baseRevision: getSectionBaseRevision(section),
        }));
    }
    const current = buildPatchSnapshot(trackerState);
    const operations = [];

    PATCHABLE_RECORD_COLLECTIONS.forEach((section) => {
      const previousCollection = acknowledgedPatchSnapshot.collections[section];
      const currentCollection = current.collections[section];
      // A collection the startup does not have (an older category list) is empty.
      const recordsById = new Map((trackerState[section] || []).map((record) => [String(record.id), record]));
      const blockedIds = blockedRecordIds(section);

      previousCollection.ids.forEach((id) => {
        if (!blockedIds.has(id) && !currentCollection.signatures.has(id)) {
          operations.push({
            type: "delete",
            section,
            id,
            baseRevision: getRecordBaseRevision(section, id),
          });
        }
      });
      currentCollection.ids.forEach((id, position) => {
        if (!blockedIds.has(id)
          && currentCollection.signatures.get(id) !== previousCollection.signatures.get(id)) {
          const operation = {
            type: "upsert",
            section,
            id,
            value: recordsById.get(id),
            // A record this client has never seen from the server is new, and a
            // base of 0 tells the server to expect it not to exist yet.
            baseRevision: getRecordBaseRevision(section, id),
          };
          // Existing records keep their position. A separate reorder operation
          // owns ordering, which avoids moving a record based on a stale index.
          if (!previousCollection.signatures.has(id)) operation.position = position;
          operations.push(operation);
        }
      });
      // A blocked create/delete means the two sides disagree on membership.
      // Reordering that section would include a missing ID or omit a server ID,
      // so hold the order change until the record decision is resolved.
      // New records carry their own position and removed ones are deletes, so
      // only a change in the order of records both sides hold is a reorder.
      // Sending one for every addition would collide with any other writer
      // (another tab, an AI agent) adding to the same section.
      const kept = previousCollection.ids.filter((id) => currentCollection.signatures.has(id));
      const order = currentCollection.ids.filter((id) => previousCollection.signatures.has(id));
      if (blockedIds.size === 0 && !hasBlockedSectionOperation(section)
        && JSON.stringify(kept) !== JSON.stringify(order)) {
        operations.push({
          type: "reorder",
          section,
          ids: currentCollection.ids,
          baseRevision: getSectionBaseRevision(section),
        });
      }
    });

    current.sections.forEach((signature, section) => {
      if (!hasBlockedSectionOperation(section)
        && signature !== acknowledgedPatchSnapshot.sections.get(section)) {
        operations.push({
          type: "replaceSection",
          section,
          value: trackerState[section],
          baseRevision: getSectionBaseRevision(section),
        });
      }
    });
    acknowledgedPatchSnapshot.sections.forEach((signature, section) => {
      if (!hasBlockedSectionOperation(section) && !current.sections.has(section)) {
        operations.push({
          type: "replaceSection",
          section,
          value: null,
          baseRevision: getSectionBaseRevision(section),
        });
      }
    });
    return operations;
  }

  // Copy-on-write: the top level is shallow-copied and only the sections an
  // operation actually touches get a new array. Deep-cloning the whole state
  // here copied ~6MB to change one record.
  function applyOperationsToPersistedState(baseState, operations, updatedAt) {
    const nextState = { ...(baseState || {}) };
    const copiedSections = new Set();

    const sectionRecords = (section) => {
      if (!copiedSections.has(section)) {
        nextState[section] = Array.isArray(nextState[section]) ? nextState[section].slice() : [];
        copiedSections.add(section);
      }
      return nextState[section];
    };

    operations.forEach((operation) => {
      if (operation.type === "replaceSection") {
        nextState[operation.section] = clonePersistedState(operation.value);
        copiedSections.add(operation.section);
        return;
      }
      const records = sectionRecords(operation.section);
      if (operation.type === "delete") {
        nextState[operation.section] = records.filter((record) => String(record?.id || "") !== operation.id);
        return;
      }
      if (operation.type === "upsert") {
        const index = records.findIndex((record) => String(record?.id || "") === operation.id);
        // A new record lands where it was sent, as on the server; appending it
        // would make the next save see a changed order.
        if (index === -1 && Number.isInteger(operation.position)) records.splice(Math.min(operation.position, records.length), 0, clonePersistedState(operation.value));
        else if (index === -1) records.push(clonePersistedState(operation.value));
        else records[index] = clonePersistedState(operation.value);
        return;
      }
      if (operation.type === "reorder") {
        const byId = new Map(records.map((record) => [String(record?.id || ""), record]));
        nextState[operation.section] = operation.ids.map((id) => byId.get(id)).filter(Boolean);
      }
    });
    nextState.updatedAt = updatedAt || new Date().toISOString();
    return nextState;
  }

  function makeMutationId() {
    return globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  // The signature of the last server-acknowledged state. Computing it costs a
  // full-state stringify, and only the focus-sync comparison actually reads it,
  // so it is derived on demand instead of on every save.
  function getInFlightContentSignature() {
    if (!inFlightPersistedState) return null;
    return getPersistedContentSignature(inFlightPersistedState);
  }

  function getLastPersistedContentSignature() {
    if (state.lastPersistedContentSignature === null && acknowledgedPersistedState) {
      state.lastPersistedContentSignature = getPersistedContentSignature(acknowledgedPersistedState);
    }
    return state.lastPersistedContentSignature;
  }

  function getPersistedContentSignature(trackerState) {
    const comparableState = { ...trackerState };
    delete comparableState.updatedAt;
    TRACKER_UI_STATE_KEYS.forEach((key) => delete comparableState[key]);
    // Use native JSON.stringify which is orders of magnitude faster than the
    // recursive key-sorting stableStringify. Within a single browser session
    // key order is stable, so this is safe for equality checks.
    return JSON.stringify(comparableState);
  }

  function compareItems(a, b) {
    const priorityDifference = (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2);
    if (priorityDifference) return priorityDifference;

    const aTime = new Date(a.updatedAt || 0).getTime();
    const bTime = new Date(b.updatedAt || 0).getTime();
    return bTime - aTime;
  }

  // A marketing category in the nested shape, also one this startup turned
  // off or one the library lacks, so a target never shows under another.
  function getCategory(id) {
    return categories.find((category) => category.id === id) || Taxonomy.nestedCategory(id, "mk");
  }

  function findCampaign(id) {
    if (id === undefined || id === null) return undefined;
    return getIdIndex(state.campaigns).get(id);
  }

  function findDailyLink(id) {
    if (id === undefined || id === null) return undefined;
    return getIdIndex(state.dailyLinks).get(id);
  }

  function findAiAccount(id) {
    if (id === undefined || id === null) return undefined;
    return getIdIndex(state.aiAccounts).get(id);
  }

  function findAiFlowItem(id) {
    if (id === undefined || id === null) return undefined;
    return getIdIndex(state.aiFlow).get(id);
  }

  function findFeedbackItem(id) {
    if (id === undefined || id === null) return undefined;
    return getIdIndex(state.feedbackItems).get(id);
  }

  function findMediaItem(id) {
    if (id === undefined || id === null) return undefined;
    return getIdIndex(state.mediaItems).get(id);
  }

  function getCampaignName(id) {
    return findCampaign(id)?.name || "";
  }

  function countCampaignItems(id) {
    return state.items.filter((item) => item.campaignId === id).length
      + state.programs.filter((item) => item.campaignId === id).length
      + state.funding.filter((item) => item.campaignId === id).length;
  }

  function getCampaignItems(id) {
    return state.items.filter((item) => item.campaignId === id);
  }

  function campaignStatusWeight(status) {
    const order = { active: 0, planned: 1, paused: 2, done: 3, archived: 4 };
    return order[status] ?? 99;
  }

  function dailyPriorityWeight(priority) {
    const order = { High: 0, Medium: 1, Low: 2 };
    return order[priority] ?? 99;
  }

  function feedbackStatusWeight(status) {
    const order = { new: 0, reviewing: 1, acted: 2, archived: 3 };
    return order[status] ?? 99;
  }

  // Media types are a shared list (Media > Options).
  function getMediaTypeLabel(type) {
    return Options.label("mediaTypes", type) || Options.label("mediaTypes", "other");
  }

  function getMediaSourceLabel(sourceType) {
    const labels = {
      upload: t("app.getMediaSourceLabel.uploadedFile"),
      url: "URL",
      "local-path": t("app.getMediaSourceLabel.pcPath"),
    };
    return labels[sourceType] || t("app.getMediaSourceLabel.source");
  }

  function mediaSourceDisplayValue(media) {
    if (media.sourceType === "upload") {
      return pcDisplayPath(media.absolutePath || uploadedMediaDisplayPath(media) || media.filePath);
    }
    if (media.sourceType === "local-path") {
      return pcDisplayPath(localMediaDisplayPath(media.externalPath) || media.externalPath || media.filePath || "");
    }
    return media.externalPath || media.filePath || "";
  }

  function uploadedMediaDisplayPath(media) {
    const storedName = mediaStoredName(media);
    if (!state.mediaDir || !storedName) return "";
    return joinDisplayPath(state.mediaDir, storedName);
  }

  function mediaStoredName(media) {
    if (media.storedName) return media.storedName;
    const rawPath = String(media.filePath || "").split(/[?#]/)[0].replace(/\\/g, "/");
    const fileName = rawPath.split("/").filter(Boolean).pop() || "";
    try {
      return decodeURIComponent(fileName);
    } catch {
      return fileName;
    }
  }

  function joinDisplayPath(dir, fileName) {
    const separator = String(dir).includes("\\") ? "\\" : "/";
    return `${String(dir).replace(/[\\/]+$/, "")}${separator}${fileName}`;
  }

  function pcDisplayPath(value) {
    const raw = String(value || "").trim();
    const match = raw.match(/^\/mnt\/([a-z])\/(.+)$/i);
    if (!match) return raw;
    return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, "\\")}`;
  }

  function localMediaDisplayPath(value) {
    if (!state.mediaDir) return "";
    const normalized = String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!normalized) return "";
    if (normalized === "media") return state.mediaDir;
    if (normalized.startsWith("media/")) {
      return joinDisplayPath(state.mediaDir, normalized.slice("media/".length));
    }

    const normalizedMediaDir = state.mediaDir.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalized.startsWith(`${normalizedMediaDir}/`)) {
      return joinDisplayPath(state.mediaDir, normalized.slice(normalizedMediaDir.length + 1));
    }
    return "";
  }

  function renderMediaSourceBlock(media, sourceValue) {
    return `
      <div class="media-source-row">
        <div class="media-source-path"><code>${escapeHtml(sourceValue)}</code></div>
        ${renderMediaSourceActions(media)}
      </div>
    `;
  }

  function renderMediaSourceActions(media) {
    if (!mediaSourceDisplayValue(media)) return "";
    return `
      <div class="media-source-actions">
        <button class="secondary-button text-btn media-source-action" type="button" data-media-action="copy-path" data-id="${escapeAttribute(media.id)}" data-tooltip="${escapeAttribute(t("app.renderMediaSourceActions.copyPath"))}">
          <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          ${escapeHtml(t("app.renderMediaSourceActions.copyPath"))}
        </button>
      </div>
    `;
  }

  function showCopySuccess(btn, durationMs = 2000) {
    if (!btn) return;
    if (btn._copyTimeout) {
      clearTimeout(btn._copyTimeout);
      btn._copyTimeout = null;
    }
    if (!btn._origHtml) {
      btn._origHtml = btn.innerHTML;
    }
    const svgEl = btn.querySelector("svg");
    if (svgEl) {
      if (!btn._origSvgHtml) {
        btn._origSvgHtml = svgEl.outerHTML;
      }
      const width = svgEl.getAttribute("width") || "16";
      const height = svgEl.getAttribute("height") || "16";
      const viewBox = svgEl.getAttribute("viewBox") || "0 0 24 24";
      const strokeWidth = svgEl.getAttribute("stroke-width") || "2.5";
      const className = svgEl.getAttribute("class") || "icon";

      const checkSvgHtml = `<svg viewBox="${viewBox}" width="${width}" height="${height}" stroke="currentColor" stroke-width="${strokeWidth}" fill="none" stroke-linecap="round" stroke-linejoin="round" class="${className}"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
      svgEl.outerHTML = checkSvgHtml;
    }
    btn.classList.add("copy-success");

    btn._copyTimeout = setTimeout(() => {
      if (btn._origSvgHtml && btn.querySelector("svg")) {
        const currentSvg = btn.querySelector("svg");
        currentSvg.outerHTML = btn._origSvgHtml;
      } else if (btn._origHtml) {
        btn.innerHTML = btn._origHtml;
      }
      btn.classList.remove("copy-success");
      delete btn._origHtml;
      delete btn._origSvgHtml;
      btn._copyTimeout = null;
    }, durationMs);
  }

  async function copyPlainText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    copyTextFallback(text);
  }

  async function copyMediaPath(media, triggerBtn = null) {
    const text = mediaSourceDisplayValue(media);
    if (!text) {
      markSaved(t("app.copyMediaPath.noPathToCopy"));
      return;
    }

    try {
      await copyPlainText(text);
      markSaved(t("app.copyMediaPath.pathCopied"));
      if (triggerBtn) showCopySuccess(triggerBtn);
    } catch (error) {
      markSaved(t("app.copyMediaPath.copyFailed"));
    }
  }

  function copyTextFallback(text) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) {
      throw new Error("Copy command failed");
    }
  }

  function mediaOpenPayload(media, mode) {
    return {
      mode,
      sourceType: media.sourceType,
      filePath: media.filePath || "",
      absolutePath: media.absolutePath || "",
      externalPath: media.externalPath || "",
      storedName: media.storedName || "",
    };
  }

  function canPreviewMediaDocument(media) {
    return isMarkdownMedia(media) && !!mediaDocumentFetchHref(media);
  }

  function mediaDocumentFetchHref(media) {
    if (media.sourceType === "upload") {
      return mediaOpenHref(media);
    }
    if (media.sourceType === "local-path") {
      return localMediaFetchHref(media.externalPath);
    }
    return "";
  }

  function canSaveMediaDocument(media) {
    return state.apiReady && media && isMarkdownMedia(media) && !!mediaDocumentFetchHref(media);
  }

  function localMediaFetchHref(value) {
    const normalized = String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!normalized || /^[a-z][a-z0-9+.-]*:/i.test(normalized)) return "";
    // "/media/<file>" from before startups existed is redirected by the server
    // to the startup that holds the file.
    if (normalized.startsWith("/media/")) return encodeURI(normalized);
    // "media/<file>" is relative to this startup's media folder.
    if (normalized.startsWith("media/")) return Api.media(normalized.slice("media/".length));

    if (state.mediaDir) {
      const normalizedMediaDir = state.mediaDir.replace(/\\/g, "/").replace(/\/+$/, "");
      if (normalized.startsWith(`${normalizedMediaDir}/`)) {
        return Api.media(normalized.slice(normalizedMediaDir.length + 1));
      }
    }
    return "";
  }

  function isMarkdownMedia(media) {
    const text = `${media.mimeType || ""} ${media.originalName || ""} ${media.filePath || ""} ${media.absolutePath || ""} ${media.externalPath || ""}`.toLowerCase();
    return text.includes("text/markdown") || /\.(md|markdown)(?:[\s?#]|$)/i.test(text);
  }

  async function openMediaDocumentModal(media) {
    if (!media) return;

    if (
      state.mediaDocumentLoading &&
      state.mediaDocumentItemId === media.id &&
      isModalOpen(elements.mediaDocumentModal)
    ) {
      return;
    }

    const href = mediaDocumentFetchHref(media);
    if (!href) {
      markSaved(t("app.openMediaDocumentModal.previewUnavailable"));
      return;
    }

    const requestId = ++state.mediaDocumentRequestId;
    state.mediaDocumentItemId = media.id;
    state.mediaDocumentLoading = true;
    state.mediaDocumentOriginalText = "";

    elements.mediaDocumentModalTitle.textContent = media.title || t("app.openMediaDocumentModal.document");
    elements.mediaDocumentPath.textContent = mediaSourceDisplayValue(media) || media.originalName || t("app.openMediaDocumentModal.markdownDocument");
    elements.mediaDocumentInput.value = "";
    elements.mediaDocumentInput.disabled = true;
    elements.mediaDocumentInput.placeholder = t("app.openMediaDocumentModal.loadingDocumentContent");
    elements.mediaDocumentPreview.innerHTML = `
      <div class="media-document-loading">
        <div class="media-document-spinner"></div>
        <span>${escapeHtml(t("app.openMediaDocumentModal.loadingDocument"))}</span>
      </div>
    `;
    elements.saveMediaDocumentModal.disabled = true;
    elements.saveMediaDocumentModal.textContent = t("app.openMediaDocumentModal.loading");

    activateMediaDocumentTab("preview");

    elements.mediaDocumentModal.hidden = false;
    elements.mediaDocumentModal.offsetHeight;
    elements.mediaDocumentModal.classList.add("open");
    markSaved(t("app.openMediaDocumentModal.loadingDocument"));

    try {
      const response = await fetch(href, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();

      if (state.mediaDocumentRequestId !== requestId) return;
      if (!isModalOpen(elements.mediaDocumentModal) || state.mediaDocumentItemId !== media.id) return;

      state.mediaDocumentLoading = false;
      state.mediaDocumentOriginalText = text;
      elements.mediaDocumentInput.disabled = false;
      elements.mediaDocumentInput.placeholder = "";
      elements.mediaDocumentInput.value = text;
      updateMediaDocumentPreview();
      updateMediaDocumentSaveState();
      markSaved(t("app.openMediaDocumentModal.documentLoaded"));
    } catch (error) {
      if (state.mediaDocumentRequestId !== requestId) return;
      if (!isModalOpen(elements.mediaDocumentModal) || state.mediaDocumentItemId !== media.id) return;

      state.mediaDocumentLoading = false;
      elements.mediaDocumentInput.disabled = true;
      elements.mediaDocumentInput.placeholder = t("app.openMediaDocumentModal.failedToLoadDocumentContent");
      elements.mediaDocumentPreview.innerHTML = `
        <div class="media-document-error">
          <svg viewBox="0 0 24 24" width="28" height="28" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          <h4>${escapeHtml(t("app.openMediaDocumentModal.unableToLoadDocument"))}</h4>
          <p>${escapeHtml(error.message || t("app.openMediaDocumentModal.failedToFetchDocumentContent"))}</p>
          <button class="secondary-button" type="button" data-media-retry-id="${escapeAttribute(media.id)}">${escapeHtml(t("app.openMediaDocumentModal.retry"))}</button>
        </div>
      `;
      elements.saveMediaDocumentModal.disabled = true;
      elements.saveMediaDocumentModal.textContent = t("app.openMediaDocumentModal.loadFailed");
      markSaved(t("app.openMediaDocumentModal.documentLoadFailed"));
    }
  }

  function activateMediaDocumentTab(tabName) {
    const activeTab = tabName === "edit" ? "edit" : "preview";
    document.querySelectorAll("#mediaDocumentModal .notes-editor-tab").forEach((tab) => {
      const isActive = tab.dataset.mediaDocumentTab === activeTab;
      tab.classList.toggle("active", isActive);
      tab.setAttribute("aria-selected", isActive);
    });
    document.querySelectorAll("#mediaDocumentModal .notes-editor-pane").forEach((pane) => pane.classList.remove("active"));

    const pane = document.getElementById(activeTab === "edit" ? "mediaDocumentPaneEdit" : "mediaDocumentPanePreview");
    if (pane) pane.classList.add("active");

    if (activeTab === "preview") {
      if (!state.mediaDocumentLoading) {
        updateMediaDocumentPreview();
      }
    } else {
      if (!state.mediaDocumentLoading) {
        setTimeout(() => elements.mediaDocumentInput.focus(), 0);
      }
    }
  }

  function hasMediaDocumentModalUnsavedChanges() {
    if (!elements.mediaDocumentModal || elements.mediaDocumentModal.hidden || state.mediaDocumentLoading) return false;
    const currentText = elements.mediaDocumentInput ? elements.mediaDocumentInput.value : "";
    return currentText !== (state.mediaDocumentOriginalText || "");
  }

  function hideMediaDocumentModal() {
    state.mediaDocumentRequestId = (state.mediaDocumentRequestId || 0) + 1;
    state.mediaDocumentLoading = false;
    elements.mediaDocumentModal.classList.remove("open");
    setTimeout(() => {
      if (!elements.mediaDocumentModal.classList.contains("open")) {
        elements.mediaDocumentModal.hidden = true;
        state.mediaDocumentItemId = null;
        state.mediaDocumentOriginalText = "";
        elements.mediaDocumentInput.value = "";
        elements.mediaDocumentInput.disabled = false;
        elements.mediaDocumentInput.placeholder = "";
        elements.mediaDocumentPreview.innerHTML = "";
      }
    }, 200);
  }

  function requestCloseMediaDocumentModal() {
    if (hasMediaDocumentModalUnsavedChanges() && !confirmDiscardModalChanges()) {
      return false;
    }
    hideMediaDocumentModal();
    return true;
  }

  async function saveMediaDocumentChanges() {
    const media = findMediaItem(state.mediaDocumentItemId);
    if (!canSaveMediaDocument(media)) {
      markSaved(t("app.saveMediaDocumentChanges.saveUnavailable"));
      return;
    }

    const content = elements.mediaDocumentInput.value || "";
    try {
      const response = await fetch(API_MEDIA_DOCUMENT_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...mediaOpenPayload(media, "file"), content }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }

      media.filePath = payload.path || media.filePath;
      media.absolutePath = payload.absolutePath || media.absolutePath;
      media.size = Number(payload.size) || media.size;
      media.updatedAt = payload.updatedAt || new Date().toISOString();
      state.mediaDocumentOriginalText = content;
      updateMediaDocumentSaveState();
      updateMediaDocumentPreview();
      await persist(t("app.saveMediaDocumentChanges.documentSaved"));
      renderMediaList();
    } catch (error) {
      markSaved(t("app.saveMediaDocumentChanges.documentSaveFailed"));
    }
  }

  function updateMediaDocumentPreview() {
    if (state.mediaDocumentLoading) return;
    const text = elements.mediaDocumentInput.value || "";
    if (!text.trim()) {
      elements.mediaDocumentPreview.innerHTML = `<p style="color: var(--muted); font-style: italic;">${escapeHtml(t("app.renderMediaDocumentPreview.empty"))}</p>`;
      return;
    }
    elements.mediaDocumentPreview.innerHTML = renderMarkdown(text);
  }

  function updateMediaDocumentSaveState() {
    if (state.mediaDocumentLoading) {
      elements.saveMediaDocumentModal.disabled = true;
      elements.saveMediaDocumentModal.textContent = t("app.updateMediaDocumentSaveState.loading");
      return;
    }
    const media = findMediaItem(state.mediaDocumentItemId);
    const canSave = canSaveMediaDocument(media);
    const changed = elements.mediaDocumentInput.value !== state.mediaDocumentOriginalText;
    elements.saveMediaDocumentModal.disabled = !canSave || !changed;
    elements.saveMediaDocumentModal.textContent = canSave ? t("app.updateMediaDocumentSaveState.saveFile") : t("app.updateMediaDocumentSaveState.uploadedMdOnly");
  }

  function updateMediaSourceMode() {
    if (!elements.mediaSourceInput) return;
    const sourceType = elements.mediaSourceInput.value;
    const isUpload = sourceType === "upload";
    elements.mediaFileLabel.hidden = !isUpload;
    elements.mediaPathLabel.hidden = isUpload;
    elements.mediaFileInput.required = isUpload;
    elements.mediaPathInput.required = !isUpload;
    if (isUpload) {
      elements.mediaPathInput.value = "";
    } else {
      elements.mediaFileInput.value = "";
    }
  }

  // Media keep their uses as links now; an old "usedIn" list is not saved again.
  function buildPersistedMediaItems() {
    return state.mediaItems.map((media) => {
      const { usedIn: _usedIn, ...rest } = media;
      return rest;
    });
  }

  function parseTagList(value) {
    return normalizeTagArray(String(value || "").split(/[,;\n]/));
  }

  function normalizeTagArray(tags) {
    return Array.from(
      new Set(
        (Array.isArray(tags) ? tags : [])
          .map((tag) => String(tag || "").trim().toLowerCase())
          .filter((tag) => tag.length > 0 && tag.length <= 60),
      ),
    );
  }

  function getAllMediaTags() {
    const tags = new Set();
    state.mediaItems.forEach((media) => (media.tags || []).forEach((tag) => tags.add(tag)));
    return Array.from(tags).sort((a, b) => a.localeCompare(b));
  }

  function guessMediaType(item) {
    const text = `${item.mimeType || ""} ${item.originalName || ""} ${item.filePath || item.path || ""} ${item.absolutePath || ""} ${item.externalPath || item.url || ""}`.toLowerCase();
    if (text.includes("video/") || /\.(mp4|webm|mov)(\?|#|$)/i.test(text)) return "video";
    if (text.includes("pdf") || /\.(pdf|txt|md|markdown|docx?|pptx?|xlsx?)(?:[\s?#]|$)/i.test(text)) return "document";
    if (text.includes("logo")) return "logo";
    if (text.includes("infographic")) return "infographic";
    return "screenshot";
  }

  function mediaTitleFromPath(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      const url = new URL(raw);
      const last = url.pathname.split("/").filter(Boolean).pop();
      return decodeURIComponent(last || url.hostname || raw);
    } catch {
      return raw.split(/[\\/]/).filter(Boolean).pop() || raw;
    }
  }

  function mediaOpenHref(media) {
    if (media.sourceType === "upload" && media.filePath && media.filePath.startsWith("/media/")) {
      return media.filePath;
    }
    if (media.sourceType === "url") {
      return safeLink(media.externalPath);
    }
    return "";
  }

  function isImageMedia(media, href) {
    return (
      String(media.mimeType || "").startsWith("image/") ||
      /\.(png|jpe?g|webp|gif|svg)(\?|#|$)/i.test(href || media.filePath || media.externalPath || "")
    );
  }

  function isVideoMedia(media, href) {
    return (
      String(media.mimeType || "").startsWith("video/") ||
      /\.(mp4|webm|mov)(\?|#|$)/i.test(href || media.filePath || media.externalPath || "")
    );
  }

  function formatDateRange(startDate, endDate) {
    if (startDate && endDate) return `${formatDate(startDate)} - ${formatDate(endDate)}`;
    if (startDate) return t("app.formatDateRange.starts", { startDate: formatDate(startDate) });
    if (endDate) return t("app.formatDateRange.ends", { endDate: formatDate(endDate) });
    return "";
  }

  function getSubcategoriesDisplay(item) {
    const subs = item.subcategories || (item.subcategory ? [item.subcategory] : []);
    return subs.map((subId) => Taxonomy.name(subId)).filter(Boolean).join(", ");
  }

  function getStatusLabel(id) {
    return Statuses.label(id);
  }

  function findItem(id) {
    if (id === undefined || id === null) return undefined;
    return getIdIndex(state.items).get(id);
  }

  // The next date of a repeating target. Months are clamped to the month's last
  // day, so a target on 31 January repeats on 28 (or 29) February.
  function calculateNextDate(currentDateStr, repeatInterval, repeatUnit) {
    if (!currentDateStr || !repeatInterval || !repeatUnit) return "";
    if (!Dates.isDateString(currentDateStr)) return "";
    const interval = parseInt(repeatInterval, 10);
    if (isNaN(interval) || interval <= 0) return "";

    if (repeatUnit === "days") return Dates.addDays(currentDateStr, interval);
    if (repeatUnit === "weeks") return Dates.addDays(currentDateStr, interval * 7);
    if (repeatUnit === "months") return Dates.addMonths(currentDateStr, interval);
    return "";
  }

  function handleRepeatingTarget(item) {
    if (!item.repeatUnit || !item.repeatInterval || item.hasRepeated) return;
    const nextDate = calculateNextDate(item.date, item.repeatInterval, item.repeatUnit);
    if (!nextDate) return;

    // Clone the item
    // Clear results & metrics from extraParams
    const cleanExtraParams = { ...item.extraParams };
    const metricKeys = [
      "impressions",
      "upvotes",
      "comments",
      "clicks",
      "starsDelta",
      "referrals",
      "installs",
      "engagementScore",
      "sentiment"
    ];
    metricKeys.forEach((key) => {
      delete cleanExtraParams[key];
    });

    const nextItem = normalizeItem({
      id: makeId(),
      campaignId: item.campaignId,
      category: item.category,
      subcategories: [...(item.subcategories || [])],
      subcategory: item.subcategory,
      platform: item.platform,
      link: item.link,
      // The next occurrence of a repeating target already has its date.
      status: "scheduled",
      priority: item.priority,
      date: nextDate,
      time: item.time,
      notes: item.notes,
      tags: [...(item.tags || [])],
      extraParams: cleanExtraParams,
      repeatInterval: item.repeatInterval,
      repeatUnit: item.repeatUnit,
      hasRepeated: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    if (nextItem) {
      state.items.unshift(nextItem);
      item.hasRepeated = true;
    }
  }

  // Midnight of today on the same wall-clock scale as dateWeight(), so the two
  // compare directly.
  function startOfToday() {
    return new Date(Dates.wallClockValue(todayDate()));
  }

  // A sort key for a stored date and time. It reads the wall clock as if it
  // were UTC, so the order never depends on the computer's zone or on DST.
  function dateWeight(value, time = "00:00") {
    const safeTime = /^\d{2}:\d{2}$/.test(time) ? time : "00:00";
    const cacheKey = `${value || ""}\u0000${safeTime}`;
    if (dateWeightCache.has(cacheKey)) return dateWeightCache.get(cacheKey);

    const weight = Dates.isDateString(value) ? Dates.wallClockValue(value, safeTime) : Number.MAX_SAFE_INTEGER;
    if (dateWeightCache.size >= 8192) dateWeightCache.clear();
    dateWeightCache.set(cacheKey, weight);
    return weight;
  }

  function formatDateTime(dateValue, timeValue) {
    const dateText = formatDate(dateValue);
    if (dateText === t("app.formatDateTime.noDate")) return dateText;
    return `${dateText} ${timeValue || ""}`.trim();
  }

  // `key` names the use for readers; formatters are cached by locale and
  // options in dates.js, so a change of zone or locale never reuses a stale one.
  function getDateFormatter(key, options) {
    return Dates.getFormatter(getLocale(), options);
  }

  // A calendar date in the format chosen in Settings > General.
  function formatDate(value) {
    const cacheKey = `${getLocale()}|${getDateFormat()}|${value || ""}`;
    if (formattedDateCache.has(cacheKey)) return formattedDateCache.get(cacheKey);
    if (!Dates.isDateString(value)) return t("app.formatDate.noDate");
    const formatted = Dates.formatDateAs(value, getLocale(), getDateFormat());
    if (formattedDateCache.size >= 2048) formattedDateCache.clear();
    formattedDateCache.set(cacheKey, formatted);
    return formatted;
  }

  // An instant (ISO stamp) in the app's time zone, with a 24-hour clock.
  function formatTimestamp(value) {
    if (!value) return "unknown";
    const cacheKey = `${getLocale()}|${getTimeZone()}|${getDateFormat()}|${value}`;
    if (formattedTimestampCache.has(cacheKey)) return formattedTimestampCache.get(cacheKey);
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "unknown";
    const formatted = Dates.formatInstantAs(date, getLocale(), getTimeZone(), getDateFormat());
    if (formattedTimestampCache.size >= 2048) formattedTimestampCache.clear();
    formattedTimestampCache.set(cacheKey, formatted);
    return formatted;
  }

  function formatShortTimestamp(value) {
    if (!value) return "";
    const cacheKey = `${getLocale()}|${getTimeZone()}|${getDateFormat()}|${value}`;
    if (formattedShortTimestampCache.has(cacheKey)) return formattedShortTimestampCache.get(cacheKey);
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const formatted = Dates.formatInstantAs(date, getLocale(), getTimeZone(), getDateFormat());
    if (formattedShortTimestampCache.size >= 2048) formattedShortTimestampCache.clear();
    formattedShortTimestampCache.set(cacheKey, formatted);
    return formatted;
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }

  // Today's date and the current time ("HH:MM") in the app's time zone, for
  // "today" checks and as the default of new date and time fields.
  function nowDateTimeParts() {
    return Dates.nowPartsIn(getTimeZone());
  }

  function todayDate() {
    return Dates.todayIn(getTimeZone());
  }

  function makeId(seed = "") {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `${Date.now()}-${seed}-${Math.random().toString(16).slice(2)}`;
  }

  // Only web, mail and phone addresses become links. Anything else
  // (javascript:, data:, file: and the like) stays plain text.
  const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

  function safeLink(value) {
    if (!value) return "";
    try {
      const url = new URL(String(value).trim());
      return SAFE_LINK_PROTOCOLS.has(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  }

  // A stored link keeps what was typed, except script and file schemes, which
  // are dropped so they can never turn into a link anywhere in the app.
  const DROPPED_LINK_SCHEMES = /^\s*(?:javascript|vbscript|data|file|blob):/i;

  function cleanStoredLink(value) {
    const raw = String(value || "").trim();
    return DROPPED_LINK_SCHEMES.test(raw) ? "" : raw;
  }

  // Markdown can carry raw HTML. The page's security policy already blocks
  // scripts and inline handlers; this also drops active elements, handler
  // attributes and unsafe link targets, and every link shows where it goes.
  const UNSAFE_RENDERED_TAGS = "script,style,iframe,frame,frameset,object,embed,link,meta,base";

  function isSafeRenderedUrl(value, attributeName) {
    const raw = String(value || "").trim();
    if (!raw) return false;
    if (raw.startsWith("#") || /^\/(?!\/)/.test(raw)) return true;
    if (attributeName === "src" && /^(?:blob:|data:image\/)/i.test(raw)) return true;
    return Boolean(safeLink(raw));
  }

  function sanitizeRenderedHtml(html) {
    if (typeof document === "undefined" || !document.createElement) {
      return html.replace(/<a\s+href=/gi, '<a target="_blank" rel="noreferrer" href=');
    }
    const template = document.createElement("template");
    template.innerHTML = html;
    template.content.querySelectorAll(UNSAFE_RENDERED_TAGS).forEach((node) => node.remove());
    template.content.querySelectorAll("*").forEach((node) => {
      for (const attribute of [...node.attributes]) {
        const name = attribute.name.toLowerCase();
        if (name.startsWith("on")) node.removeAttribute(attribute.name);
        else if (["href", "src", "xlink:href", "action", "formaction", "srcset"].includes(name) && !isSafeRenderedUrl(attribute.value, name)) {
          node.removeAttribute(attribute.name);
        }
      }
    });
    template.content.querySelectorAll("a[href]").forEach((anchor) => {
      anchor.setAttribute("target", "_blank");
      anchor.setAttribute("rel", "noreferrer");
      if (!anchor.hasAttribute("title")) anchor.setAttribute("title", anchor.getAttribute("href"));
    });
    return template.innerHTML;
  }

  function markSyncing(message = t("app.markSyncing.syncingData")) {
    if (!elements.saveStateLabel) return;
    elements.saveStateLabel.classList.remove("synced", "conflict", "saving");
    elements.saveStateLabel.classList.add("syncing");
    elements.saveStateLabel.innerHTML = `<span class="status-spinner"></span><span>${escapeHtml(message)}</span>`;
    elements.saveStateLabel.setAttribute("data-tooltip", message);
  }

  // The save-state badge's own states; anything else is shown as it is,
  // with the time.
  const SAVE_STATE = Object.freeze({ synced: "synced", conflict: "conflict", offline: "offline", local: "local" });

  function markSaved(message) {
    if (!elements.saveStateLabel) return;
    elements.saveStateLabel.classList.remove("syncing", "saving");
    const timeStr = getDateFormatter("saveTime", {
      timeZone: getTimeZone(),
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date());

    if (message === SAVE_STATE.synced) {
      elements.saveStateLabel.innerHTML = `<svg class="status-sync-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"></path></svg><span>${tHtml("app.markSaved.synced", { timeStr: escapeHtml(timeStr) })}</span>`;
      elements.saveStateLabel.classList.remove("conflict");
      elements.saveStateLabel.classList.add("synced");
      elements.saveStateLabel.setAttribute("data-tooltip", t("app.markSaved.dataSynchronizedWithStorageAt", { timeStr }));
      return;
    }

    if (message === SAVE_STATE.conflict) {
      elements.saveStateLabel.classList.remove("synced");
      elements.saveStateLabel.classList.add("conflict");
      elements.saveStateLabel.textContent = t("app.markSaved.conflictReload");
      elements.saveStateLabel.setAttribute("data-tooltip", t("app.markSaved.theDatabaseHasBeenUpdated"));
      return;
    }

    if (message === SAVE_STATE.offline) {
      elements.saveStateLabel.classList.remove("synced", "conflict");
      elements.saveStateLabel.textContent = t("app.markSaved.backendOffline");
      elements.saveStateLabel.setAttribute("data-tooltip", t("app.markSaved.backendServerIsOfflineChanges"));
      return;
    }

    if (message === SAVE_STATE.local) {
      elements.saveStateLabel.classList.remove("synced", "conflict", "saving", "syncing");
      elements.saveStateLabel.textContent = t("app.markSaved.savedLocallyWaitingToSync");
      elements.saveStateLabel.setAttribute("data-tooltip", t("app.markSaved.thisBrowserHasKeptThe"));
      return;
    }

    elements.saveStateLabel.classList.remove("conflict", "synced");
    elements.saveStateLabel.textContent = `${message} ${timeStr}`;
    elements.saveStateLabel.setAttribute("data-tooltip", t("app.markSaved.statusAt", { message, timeStr }));
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value);
  }

  // A translated string inside HTML: its text is escaped, the parameters go
  // in as given (they are HTML already, escaped where they came from).
  function tHtml(key, params) {
    return escapeHtml(t(key)).replace(/\{(\w+)\}/g, (match, name) => (params && params[name] !== undefined && params[name] !== null ? String(params[name]) : match));
  }

  function cssEscape(value) {
    const raw = String(value || "");
    if (globalThis.CSS?.escape) return CSS.escape(raw);
    return raw.replace(/["\\]/g, "\\$&");
  }

  function autoResizeTextarea(textarea) {
    if (!textarea) return;
    if (
      textarea.id === "modalNotesInput" ||
      textarea.id === "modalProgNotes" ||
      textarea.id === "modalFundingNotes" ||
      textarea.id === "mediaDocumentInput" ||
      textarea.id === "promptMarkdownTextarea"
    ) {
      return;
    }
    // If hidden (e.g. inactive tab or hidden modal), skip resizing to avoid 0px collapse
    if (textarea.offsetParent === null && textarea.offsetWidth === 0 && textarea.offsetHeight === 0) {
      return;
    }
    textarea.style.height = "auto";
    const minHeight = textarea.rows ? Math.max(44, textarea.rows * 20 + 16) : 44;
    const computedHeight = Math.max(minHeight, textarea.scrollHeight);
    textarea.style.height = `${computedHeight}px`;
  }

  function autoResizeAllModalTextareas(root) {
    const scope = root || document;
    const textareas = scope.querySelectorAll(
      "textarea.auto-expand-field, .metadata-form-grid textarea, .program-update-form-grid textarea, .extra-param-row textarea, .modal-card-manager-notes textarea, .manager-form-v2 textarea, .manager-card textarea, .editing-card textarea, textarea"
    );
    textareas.forEach((ta) => autoResizeTextarea(ta));
  }

  function navigateToMedia(mediaId) {
    // 1. Close the target window if this came from a link in it.
    if (!RecordWindow.requestClose()) return;

    // 2. Switch to extra tab with media sub-tab
    state.selectedAppTab = "extra";
    state.selectedExtraSubTab = "media";

    // 3. Clear all filters to guarantee the item is present in the list
    state.mediaSearch = "";
    state.mediaTypeFilter = "all";
    state.mediaSourceFilter = "all";
    state.mediaTargetFilter = "all";
    state.mediaKindFilter = "all";
    state.mediaTagFilter = "all";

    if (elements.mediaSearchInput) elements.mediaSearchInput.value = "";
    if (elements.mediaTypeFilter) elements.mediaTypeFilter.value = "all";
    if (elements.mediaSourceFilter) elements.mediaSourceFilter.value = "all";
    if (elements.mediaTargetFilter) elements.mediaTargetFilter.value = "all";

    // 4. Determine which page contains this media item
    const mediaItems = getFilteredMediaItems();
    const index = mediaItems.findIndex((m) => m.id === mediaId);
    if (index !== -1) {
      state.mediaPage = Math.floor(index / MANAGER_PAGE_SIZE) + 1;
    }

    // 5. Render the page
    render();

    // 6. Scroll into view and flash highlight
    setTimeout(() => {
      const card = document.querySelector(`[data-media-id="${cssEscape(mediaId)}"]`);
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.classList.add("highlighted-media-card");
        setTimeout(() => {
          card.classList.remove("highlighted-media-card");
        }, 3000);
      }
    }, 300);
  }
  window.navigateToMedia = navigateToMedia;

  // --- Dependency target helpers ---

  function navigateToTarget(targetId) {
    const item = findItem(targetId);
    if (!item) return;
    if (!RecordWindow.requestClose()) return;
    state.selectedAppTab = "pipeline";
    state.selectedCategory = "all";
    state.selectedSubcategory = "all";
    state.selectedMkType = "all";
    render();
    sectionPages.mk?.showRecord(item.id);
  }
  window.navigateToTarget = navigateToTarget;


  function syncExtraParamPills(paramId) {
    const input = document.querySelector(`[data-modal-extra-param="${paramId}"]`);
    if (!input) return;
    const val = input.value || "";
    const selectedVals = val.split(/[,\s]+/).map(v => v.trim()).filter(Boolean);

    const checkboxes = document.querySelectorAll(`input[data-ep-pill-checkbox="${paramId}"]`);
    checkboxes.forEach(cb => {
      const isChecked = selectedVals.includes(cb.value);
      cb.checked = isChecked;
      const label = cb.closest(".subcategory-checkbox-label");
      if (label) {
        label.classList.toggle("active", isChecked);
      }
    });
  }
  window.syncExtraParamPills = syncExtraParamPills;

  function toggleElementPicker(paramId) {
    const picker = document.getElementById(`elementPicker_${paramId}`);
    const input = document.querySelector(`[data-modal-extra-param="${paramId}"]`);
    const btn = input?.nextElementSibling;
    if (picker) {
      const isHidden = picker.classList.toggle("hidden");
      if (btn) {
        btn.classList.toggle("open", !isHidden);
      }
    }
  }
  window.toggleElementPicker = toggleElementPicker;

  function openElementPicker(paramId) {
    const picker = document.getElementById(`elementPicker_${paramId}`);
    const input = document.querySelector(`[data-modal-extra-param="${paramId}"]`);
    const btn = input?.nextElementSibling;
    if (picker && picker.classList.contains("hidden")) {
      picker.classList.remove("hidden");
      if (btn) {
        btn.classList.add("open");
      }
    }
  }
  window.openElementPicker = openElementPicker;

  function togglePickerCategory(paramId, catId) {
    const content = document.getElementById(`pickerCategory_${paramId}_${catId}`);
    const header = content?.previousElementSibling;
    if (content) {
      const isCollapsed = content.classList.toggle("collapsed");
      if (header) {
        header.classList.toggle("collapsed", isCollapsed);
      }
    }
  }
  window.togglePickerCategory = togglePickerCategory;

  // Markup built from templates carries data attributes instead of inline
  // handlers, because the page's security policy runs only scripts served by
  // the tracker. These document listeners handle them all. The click listener
  // runs in the capture phase so a badge or a link can keep its click from
  // reaching the row or card it sits in, as the old inline stopPropagation did.
  function bindDelegatedActions() {
    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      const mediaBadge = target.closest("[data-navigate-media]");
      if (mediaBadge) {
        navigateToMedia(mediaBadge.dataset.navigateMedia);
        return;
      }
      const categoryHeader = target.closest("[data-picker-category-param]");
      if (categoryHeader) {
        togglePickerCategory(categoryHeader.dataset.pickerCategoryParam, categoryHeader.dataset.pickerCategory);
        return;
      }
      const pickerToggle = target.closest("[data-element-picker-toggle]");
      if (pickerToggle) toggleElementPicker(pickerToggle.dataset.elementPickerToggle);
    }, true);
    document.addEventListener("focusin", (event) => {
      const input = event.target instanceof Element ? event.target.closest("[data-element-picker-open]") : null;
      if (input) openElementPicker(input.dataset.elementPickerOpen);
    });
    document.addEventListener("change", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (target.matches("input.custom-date-input")) target.setAttribute("data-date", formatDate(target.value));
    });
  }

  // Back to Top Button
  const backToTopBtn = document.getElementById("backToTopBtn");
  if (backToTopBtn) {
    const scrollThreshold = 500;

    window.addEventListener("scroll", () => {
      if (window.scrollY > scrollThreshold) {
        backToTopBtn.classList.add("visible");
      } else {
        backToTopBtn.classList.remove("visible");
      }
    }, { passive: true });

    backToTopBtn.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  // Switching Extra's pages.
  function bindExtraSubnav() {
    document.addEventListener("click", (event) => {
      const extraSubnavBtn = event.target.closest("[data-extra-tab]");
      if (!extraSubnavBtn) return;
      state.selectedExtraSubTab = extraSubnavBtn.dataset.extraTab;
      renderExtraTab();
      window.scrollTo({ top: 0, left: 0 });
    });
    window.addEventListener("resize", () => autoResizeAllModalTextareas());
  }

  // ---- Prompts (js/prompts-page.js) ---------------------------------------------
  //
  // The page asks here for the startup's profile and settings, saves your
  // prompts, presets and examples with the shared data, makes the limited
  // token a copied prompt carries, and adds the targets "Import AI results"
  // checked.

  let promptsPageInstance = null;

  function promptsPage() {
    const holder = document.querySelector("#promptsPage");
    if (promptsPageInstance || !holder || !PromptsPage) return promptsPageInstance;
    promptsPageInstance = PromptsPage.create(holder, {
      t,
      startupId: STARTUP_ID,
      shared: () => ({ prompts: state.prompts, presets: state.promptPresets, examples: state.promptExamples }),
      saveShared: (changes, message) => {
        if (changes.prompts) state.prompts = changes.prompts;
        if (changes.presets) state.promptPresets = changes.presets;
        if (changes.examples) state.promptExamples = changes.examples;
        persist(message);
      },
      deletePrompt: (prompt) => {
        if (!window.confirm(t("recycle.confirmDeletePrompt", { name: prompt.name || "" }))) return false;
        moveRecordToBin("prompts", prompt.id);
        persist(t("recycle.moved"));
        return true;
      },
      profile: () => state.profile || {},
      startupName: () => window.StartupTrackerStartups?.current?.()?.name || state.profile?.name || "",
      timeZone: getTimeZone,
      today: todayDate,
      Taxonomy,
      TaxonomyPicker: window.StartupTrackerTaxonomyPicker,
      Fields,
      PromptRender,
      AiImport,
      renderMarkdown,
      plainText: markdownToPlainText,
      copyText: (text) => navigator.clipboard.writeText(text),
      createToken: async () => {
        const response = await fetch(Api.api("/agent-tokens"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label: t("prompts.tokenLabel") }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
        return { token: body.token, expiresAt: formatTimestamp(body.record.expiresAt), expiresAtIso: body.record.expiresAt };
      },
      checkImport: (entries) => AiImport.check(entries, {
        Fields,
        isStatus: (id) => Statuses.isKnown(id),
        defaultStatus: () => Statuses.defaultStatus(),
        priorities: Object.keys(priorityOrder),
        category: (id) => Taxonomy.get(id),
        existing: Object.fromEntries(["mk", "po", "fu"].map((section) => [section, [...state[WINDOW_SECTIONS[section].collection], ...(state[`deleted${WINDOW_SECTIONS[section].collection.charAt(0).toUpperCase()}${WINDOW_SECTIONS[section].collection.slice(1)}`] || [])].map((record) => {
          const described = describeTarget(section, record);
          return { id: record.id, name: described.name, link: described.link };
        })])),
      }),
      importRows: (rows) => importAiRows(rows),
      linkLabel: (type) => (I18n.has?.(`linkTypes.types.${type}`) ? t(`linkTypes.types.${type}`) : type),
      openProfile: () => window.StartupTrackerSettingsPanel?.open?.("profile"),
      formatTimestamp: (value) => value || "",
      counted: (count) => setExtraCount("prompts", count),
      // "Run with...": the run dialog, then the run in an overlay.
      runWith: async (spec) => {
        const run = await AgentsPage.openRunDialog({ ...spec, startupName: currentStartupName() }, agentHooks());
        if (!run) return;
        agentRunCounts?.now();
        AgentsPage.openOverlay(run.id, agentHooks());
      },
      loadUi: () => {
        try {
          return JSON.parse(window.localStorage.getItem(Api.storageKey("prompts-page")) || "null") || {};
        } catch {
          return {};
        }
      },
      saveUi: (ui) => {
        try {
          window.localStorage.setItem(Api.storageKey("prompts-page"), JSON.stringify(ui));
        } catch {
          // Remembering the run's choices is a convenience only.
        }
      },
    });
    return promptsPageInstance;
  }

  // ---- Agents (js/agents-page.js) ------------------------------------------------
  //
  // The Agents page, the run overlay of the Prompts page and the sidebar
  // badge. The runs themselves live on the server (lib/agents/runs.js).

  let agentsPageInstance = null;
  let agentRunCounts = null;

  function currentStartupName() {
    return window.StartupTrackerStartups?.current?.()?.name || state.profile?.name || "";
  }

  function updateAgentBadge(counts) {
    const badge = document.querySelector("[data-agent-run-count]");
    if (!badge) return;
    const count = Number(counts?.running) || 0;
    badge.textContent = count ? String(count) : "";
    badge.hidden = !count;
    badge.toggleAttribute("data-waiting", Boolean(counts?.waiting));
    badge.title = counts?.waiting ? t("agents.badgeWaiting", { count: counts.waiting }) : "";
  }

  function agentHooks() {
    return {
      t,
      Api,
      startupId: STARTUP_ID,
      standalone: Boolean(Api.parseRunId(window.location.pathname)),
      renderMarkdown,
      formatTimestamp: (value) => (value ? formatTimestamp(value) : ""),
      openSettings: () => window.StartupTrackerSettingsPanel?.open?.("agents"),
      onCounts: updateAgentBadge,
      openRecord: (kind, id) => {
        document.querySelector("#agentRunOverlay")?.close?.();
        if (!openTargetWindow(kind, id)) window.alert(t("agents.run.recordGone"));
      },
      // The run's final JSON block, in "Import AI results" on the Prompts page.
      openImport: (text) => {
        document.querySelector("#agentRunOverlay")?.close?.();
        state.selectedAppTab = "extra";
        state.selectedExtraSubTab = "prompts";
        render();
        promptsPage()?.openImport(text);
      },
      // Run again: the same prompt, agent and model, as a new run.
      runAgain: async (run) => {
        try {
          const response = await fetch(Api.api("/agent-runs"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ harnessId: run.harnessId, model: run.model, template: run.prompt, values: {}, title: run.title, presetId: run.presetId }),
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
          agentRunCounts?.now();
          if (document.querySelector("#agentRunOverlay")?.open) AgentsPage.openOverlay(body.run.id, agentHooks());
          else agentsPage()?.openRun(body.run.id);
        } catch (error) {
          window.alert(t("agents.run.againFailed", { message: error.message }));
        }
      },
    };
  }

  function agentsPage() {
    const holder = document.querySelector("#agentsPage");
    if (agentsPageInstance || !holder || !AgentsPage) return agentsPageInstance;
    agentsPageInstance = AgentsPage.create(holder, agentHooks());
    return agentsPageInstance;
  }

  // ---- Company (js/company-page.js) ----------------------------------------------
  //
  // The template is read from the server once per id and kept here, so the
  // calendar and the search can show Company steps and deadlines without the
  // tab being open. Sensitive values never pass through the state: the page
  // reads and writes them through /company/secrets.

  let companyPageInstance = null;
  let companyTemplate = { id: "", template: null, loading: null };

  function companyIsDone(status) {
    return ["done", "closed"].includes(Statuses.groupOf(status));
  }

  function currentCompanyView() {
    return CompanyModel.view(companyTemplate.template, state, { today: todayDate(), isDone: companyIsDone });
  }

  function companyCalendarEvents() {
    if (!state.companyProfile) return [];
    return CompanyModel.calendarEvents(currentCompanyView(), { defaultStatus: Statuses.defaultStatus() });
  }

  async function fetchJsonOrThrow(url, options) {
    const response = await fetch(url, { cache: "no-store", ...options });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  }

  // Reads the picked template when it changed, then redraws what shows it.
  function loadCompanyTemplate() {
    const id = CompanyModel.normalizeProfile(state.companyProfile).templateId;
    if (id === companyTemplate.id) return companyTemplate.loading;
    companyTemplate = { id, template: null, loading: null };
    if (!id) return null;
    companyTemplate.loading = fetchJsonOrThrow(Api.urls.companyTemplate(id))
      .then((body) => {
        if (companyTemplate.id !== id) return;
        companyTemplate.template = body.template;
        if (state.selectedAppTab === "calendar") renderCalendarTab();
      })
      .catch(() => {
        // The Company tab says when its template cannot be read.
      });
    return companyTemplate.loading;
  }

  function companyPage() {
    const holder = document.querySelector("#companyPage");
    if (companyPageInstance || !holder || !CompanyPage) return companyPageInstance;
    companyPageInstance = CompanyPage.create(holder, {
      t,
      today: todayDate,
      locale: getLocale,
      startupCurrency: () => String(state.profile?.currency || ""),
      companyName: () => window.StartupTrackerStartups?.current?.()?.name || state.profile?.name || "",
      sections: () => state,
      saveProfile: (profile, message) => {
        state.companyProfile = profile;
        markDataChanged();
        persist(message);
        loadCompanyTemplate();
      },
      upsert: (section, record, message) => {
        const list = state[section] || [];
        const index = list.findIndex((entry) => String(entry.id) === String(record.id));
        state[section] = index === -1 ? [record, ...list] : list.map((entry, position) => (position === index ? record : entry));
        markDataChanged();
        persist(message);
      },
      remove: (section, id, message) => {
        if (moveRecordToBin(section, id)) persist(message);
      },
      listTemplates: () => fetchJsonOrThrow(Api.urls.companyTemplates),
      loadTemplate: async (id) => {
        if (companyTemplate.id === id && companyTemplate.template) return companyTemplate.template;
        const body = await fetchJsonOrThrow(Api.urls.companyTemplate(id));
        if (companyTemplate.id === id) companyTemplate.template = body.template;
        return body.template;
      },
      loadSecrets: async () => (await fetchJsonOrThrow(Api.api("/company/secrets"))).secrets,
      saveSecrets: async (secrets) => (await fetchJsonOrThrow(Api.api("/company/secrets"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets, origin: "ui" }),
      })).secrets,
      // The startup profile mirrors the template, for the prompts' variables.
      // (The Company profile is saved right after, which sends both.)
      templatePicked: (template) => {
        const profile = state.profile || {};
        state.profile = { ...profile, companyTemplate: template.id, entityType: template.id === "generic" ? profile.entityType || "" : template.entityType, country: profile.country || template.country || "" };
        markDataChanged();
      },
      statusOptionsHtml: (selected) => Statuses.optionsHtml(selected, { unmappedLabel: t("statusFilter.unmapped") }),
      statusBadgeHtml,
      isDone: companyIsDone,
      defaultStatus: () => Statuses.defaultStatus(),
      renderLinksPanel,
      renderMarkdown,
      copyText: (text) => navigator.clipboard.writeText(text),
      formatDate: (value) => (value ? formatDate(value) : ""),
      onTemplate: (template) => {
        if (template && companyTemplate.id === template.id) companyTemplate.template = template;
      },
      urgent: (count) => {
        const badge = document.querySelector("[data-company-urgent-count]");
        if (!badge) return;
        badge.textContent = count ? String(count) : "";
        badge.hidden = !count;
      },
    });
    return companyPageInstance;
  }

  // Targets "Import AI results" checked, added at the top of their section.
  function importAiRows(rows) {
    let count = 0;
    const now = new Date().toISOString();
    for (const row of rows) {
      const record = AiImport.toRecord(row, Fields, { id: makeId(), now });
      if (row.categories.length) applyTaxonomy(record, row.categories, { subcategories: row.section === "mk" });
      const next = WINDOW_SECTIONS[row.section].normalize(record);
      if (!next) continue;
      state[WINDOW_SECTIONS[row.section].collection].unshift(next);
      count += 1;
    }
    if (count) {
      markDataChanged();
      persist(t("prompts.import.done", { count }));
      render();
    }
    return count;
  }

  boot();
})();
