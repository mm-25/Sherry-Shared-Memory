"use strict";

// This file describes the product for review; it does not read or change Sherry data.
const areas = [
  {id:"signin",group:"Entry",title:"Sign in / out",status:"live",summary:"Enter an existing Sherry workspace.",location:"Before and after the signed-in shell",now:"Email/password sign-in and sign-out.",next:"First-use account creation, recovery, and clear capture/retrieval consent.",gate:"8A definition; 8C after Gate 9"},
  {id:"onboarding",group:"Entry",title:"First-use setup",status:"proposed",summary:"Create a workspace, connect capture, and see the first successful chat.",location:"Proposed guided entry flow",now:"No in-app account creation or guided setup.",next:"Define workspace creation, provider/browser permission steps, first capture, and empty-state handoff.",gate:"8A decision; 8C after Gate 9"},
  {id:"dashboard",group:"Explore",title:"Dashboard",status:"live",summary:"See aggregate activity and open focused metric details.",location:"Sidebar → Dashboard",now:"Live metrics and large drill-down dialogs for chats, providers, retrieval, artifacts, and pipeline.",next:"Verify the meaning, provenance, and empty/error states of every metric; avoid implying unavailable artifact contents exist.",gate:"8B inventory now; 8C after Gate 9"},
  {id:"chats",group:"Explore",title:"Chat Memory",status:"live",summary:"Find and inspect source conversations.",location:"Sidebar → Chat Memory",now:"Search and filters, chat cards, transcript and summary dialogs, source links, single-chat export/deletion.",next:"Define capture-coverage and unavailable-source states; decide how future Sources view differs from Chat Memory.",gate:"8A/8B now"},
  {id:"sources",group:"Explore",title:"Sources",status:"proposed",summary:"One place to inspect where Sherry learned information.",location:"Proposed primary destination or Chat Memory extension",now:"Conversation sources are visible in Chat Memory; no dedicated cross-source view.",next:"Decide whether this deserves a route, and how chats, notes, attachments, imports, and source accounts are grouped.",gate:"8A decision; 8C after Gate 9"},
  {id:"timeline",group:"Explore",title:"Timeline / activity",status:"proposed",summary:"Understand when capture, summaries, retrieval, edits, and deletion happened.",location:"Proposed destination; some events in Diagnostics",now:"Recent diagnostics events and timestamps are visible, but no user-facing chronology.",next:"Separate a simple personal activity trail from technical Diagnostics and decide which events belong.",gate:"8A decision; 8C after Gate 9"},
  {id:"personal",group:"Organize",title:"Personal Memory",status:"live",summary:"Keep explicit, user-owned notes and categories.",location:"Sidebar → Personal Memory",now:"Starter fields, custom categories and entries, editing and deletion.",next:"Clarify how explicit notes saved through connected AI appear here, and how they differ from conversation summaries.",gate:"8A/8B now"},
  {id:"connected",group:"Organize",title:"Connected Conversations",status:"live",summary:"Explore links between chat nodes and open a source chat.",location:"Sidebar → Connected Conversations",now:"Conversation graph, pan/zoom/full-screen, and chat detail entry.",next:"Make connection reasons and weak-link confidence understandable; do not reintroduce automatic conflict review.",gate:"8B inventory now; retrieval relevance in Gate 10"},
  {id:"projects",group:"Organize",title:"Projects / scopes",status:"proposed",summary:"Separate project-specific sources and retrieval scope.",location:"Proposed primary destination",now:"Backend concepts exist, but users cannot create and manage projects in the app.",next:"Define personal space versus projects, membership, moving sources, and scope enforcement before UI build.",gate:"8A decision; 8C after Gate 9"},
  {id:"retrieval",group:"Connect",title:"AI connections & retrieval",status:"partial",summary:"Control which AI tools may search or save notes.",location:"Settings → AI connections and retrieval",now:"Per-provider retrieval and explicit-note permissions, MCP address, and test query.",next:"Provider/account-aware connection setup and disconnect; clearer permissions and retrieval inspection.",gate:"8A/8B now; 8C after Gate 9; ranking in Gate 10"},
  {id:"inspection",group:"Connect",title:"Retrieval inspection",status:"proposed",summary:"See exactly what a connected AI received and why.",location:"Proposed detail from Dashboard, Chat Memory, or Timeline",now:"Test retrieval returns results; Dashboard shows aggregate usage. No per-call user-facing trace.",next:"Design source/provenance view, permissions, truncation, and links without exposing sensitive query text unnecessarily.",gate:"8A decision; Gate 10 evaluation"},
  {id:"connections",group:"Connect",title:"Connections & accounts",status:"proposed",summary:"Manage multiple accounts per AI provider and capture surfaces.",location:"Proposed destination or Settings group",now:"Provider permissions exist; browser extension is controlled in Diagnostics. Multiple accounts and disconnect are not managed here.",next:"Decide account identity, provider connection/disconnect, per-account filters, and extension/device controls in one clear home.",gate:"8A decision; later milestone after Gate 9"},
  {id:"summarization",group:"Control",title:"Summarization",status:"live",summary:"Configure and run conversation summaries.",location:"Settings → Summarization",now:"Schedule, model/provider, saved key, manual next-summary action; per-chat summary action in Chat Memory.",next:"Inventory failed, pending, stale, and cost-protection explanations; Gate 9 owns safety guarantees.",gate:"8B inventory now"},
  {id:"import",group:"Control",title:"Import & export",status:"partial",summary:"Bring provider histories in and take Sherry data out.",location:"Settings → Account & data",now:"ChatGPT/Claude/Gemini history import controls; conversation JSON export.",next:"Full workspace export, import progress/undo, partial failure, and artifact boundary. Current export is not a complete workspace backup.",gate:"8A/8B now; 8C after Gate 9"},
  {id:"deletion",group:"Control",title:"Deletion & retention",status:"partial",summary:"Remove individual data and eventually the whole workspace.",location:"Chat detail, summary detail, Personal Memory, Settings → Account & data",now:"Individual conversation, summary, and personal-note deletion. Whole-workspace deletion is informational only.",next:"Define full-workspace deletion, recovery, retention choices, and exactly what remains at providers; Gate 9 verifies propagation.",gate:"8A/8B now; 8C after Gate 9"},
  {id:"diagnostics",group:"Support",title:"Diagnostics",status:"live",summary:"Investigate capture, sync, processing, and extension status.",location:"Sidebar → Diagnostics",now:"Cloud pipeline, failures, extension controls, pending uploads, recent events.",next:"Design permission-denied, no-extension, partial capture, retries, and source-versus-cloud completeness states.",gate:"8B inventory now; Gate 9 safety evidence"},
  {id:"retired",group:"Support",title:"Claim/conflict review",status:"retired",summary:"Retired from the active Sherry product.",location:"Not in active navigation",now:"Old hidden view remains in code but is not a user destination; claim generation/retrieval is retired.",next:"Do not restore this tab through the IA work. Historical data handling remains a separate safety decision.",gate:"Out of active Gate 8 scope"}
];

// A review decision needs a reason and genuine alternatives, not only a feature label.
// Recommendations are proposals for discussion, not approved routes or build tasks.
const reviewContext = {
  signin: {
    card:"An existing user can sign in. Someone new cannot create an account here or understand the next setup step.",
    reason:"Today the entry screen assumes a Sherry account already exists. A new person could reach the page without knowing how to create a workspace, install capture, or understand what Sherry will store. This is the beginning of the same journey as first-use setup, not just a missing button.",
    question:"Should account creation be part of the same guided path that explains capture and gets the first conversation into Sherry, or should registration remain a separate step?",
    options:[
      {id:"guided",title:"One guided entry",detail:"Create the account, explain capture permissions, then confirm the first chat arrived."},
      {id:"separate",title:"Separate registration",detail:"Let people make an account first; begin a setup checklist only after sign-in."}
    ],
    recommendation:"Treat account creation and first capture as one journey, even if they use separate screens. That gives a new user a clear definition of ‘set up.’"
  },
  onboarding: {
    card:"There is no guided first run. A new workspace would land in the normal app without a clear first action.",
    reason:"The current Dashboard and Chat Memory are useful once data exists. They do not explain how a new user connects a browser, what capture includes, or how to verify that the first message arrived. A setup path could solve that without turning the whole product into a wizard.",
    question:"How much guidance should the first empty workspace provide before someone starts ordinary use?",
    options:[
      {id:"checklist",title:"Small setup checklist",detail:"Keep the normal app visible and show three clear steps: connect, capture, verify."},
      {id:"wizard",title:"Guided setup flow",detail:"Walk through permissions and first capture before showing the normal Dashboard."},
      {id:"empty",title:"Simple empty states",detail:"Use one action on each empty page instead of a shared setup journey."}
    ],
    recommendation:"Start with a short checklist in the real app. It keeps the product explorable while still answering ‘what do I do first?’"
  },
  dashboard: {
    card:"The Dashboard shows real metrics, but some numbers need clearer definitions and proof of what they count.",
    reason:"A metric is only useful if the person can tell whether it counts captured chats, summaries, retrievals, or something else, and can inspect the records behind it. The existing drill-down dialogs help, but empty, delayed, and unavailable data can still look like zero or a complete picture.",
    question:"Should the Dashboard remain a broad analytics home, or become a simpler overview of recent chats and things needing attention?",
    options:[
      {id:"analytics",title:"Keep the analytics home",detail:"Retain the current metric cards and make their definitions, date ranges, and underlying records clearer."},
      {id:"overview",title:"Simplify to an overview",detail:"Lead with recent chats, capture health, and a few trustworthy metrics; move deeper analysis elsewhere."}
    ],
    recommendation:"Keep it as an overview with fewer, well-explained metrics until Sherry can prove every card's underlying data. This is about clarity, not removing useful drill-downs."
  },
  chats: {
    card:"Chat Memory is the working place for transcripts and summaries; it does not yet cover every source Sherry may learn from.",
    reason:"People currently find a chat, read its transcript, inspect or edit its summary, and open the original provider conversation here. Future imported documents, attachments, and explicit notes are also sources, but calling all of those ‘Chat Memory’ would be misleading. A second Sources page could also duplicate the chat list.",
    question:"Should Chat Memory stay specifically about conversations, or grow into a broader source library?",
    options:[
      {id:"chat-only",title:"Keep chats separate",detail:"Chat Memory stays focused on conversations; a future Sources view handles other source types."},
      {id:"source-library",title:"Evolve into Sources",detail:"Rename and broaden this destination so one library contains chats, notes, and future files."}
    ],
    recommendation:"Keep Chat Memory focused for now. Decide on a separate Sources route only when Sherry has other source types people can actually browse."
  },
  sources: {
    card:"A separate Sources page is only a proposal. Right now most inspectable sources are chats inside Chat Memory.",
    reason:"‘Source’ means the original item behind something Sherry knows: a conversation, imported record, explicit note, or eventually a file. A source library could answer ‘where did this come from?’ across types. But with mostly conversations today, a new sidebar page risks repeating Chat Memory.",
    question:"When Sherry supports more source types, where should users inspect them without seeing the same chat list twice?",
    options:[
      {id:"dedicated",title:"Dedicated Sources area",detail:"Give all source types one browseable home, with Chat Memory as a focused conversation view."},
      {id:"extend-chats",title:"Expand Chat Memory",detail:"Turn the existing list into the source library and avoid another sidebar destination."},
      {id:"wait",title:"Do not add it yet",detail:"Keep source details in the chat and note views until there are real non-chat sources to browse."}
    ],
    recommendation:"Wait on a separate route. Design the source detail model now, then revisit navigation once documents and attachments are actually available."
  },
  timeline: {
    card:"Dates appear inside chats and Diagnostics, but there is no simple history of what Sherry did with a person's data.",
    reason:"A user may want to know when a chat was captured, when its summary changed, when an import ran, or when a deletion completed. Diagnostics currently shows technical events, not a coherent personal history. A Timeline could help with trust, but a full activity feed may become noisy.",
    question:"Does that history deserve its own everyday destination, or should it appear where a person is already inspecting a chat, import, or issue?",
    options:[
      {id:"top-level",title:"Separate Timeline",detail:"A chronological history across chats, summaries, imports, retrievals, and data changes."},
      {id:"contextual",title:"Activity in context",detail:"Show history on each chat or operation; keep a technical event log in Diagnostics."},
      {id:"wait",title:"Wait for real events",detail:"Specify the event data now, but do not add a new page until it is complete."}
    ],
    recommendation:"Start with contextual history, especially for import and deletion. Add a global Timeline only if people need to trace events across many sources."
  },
  personal: {
    card:"Personal Memory holds notes entered in the app. Notes explicitly saved by an AI are searchable but not easy to browse here.",
    reason:"User-authored entries have categories and editing controls. An AI tool can also save an explicit note with permission, but that note is not currently surfaced alongside the user's entries. This makes ‘Allow explicit notes’ hard to understand and leaves the user without an obvious place to inspect or correct what was saved.",
    question:"Should user-entered and AI-saved explicit notes live together, with their origin clearly labeled, or remain separate?",
    options:[
      {id:"together",title:"One notes area",detail:"Show both kinds of explicit notes in Personal Memory with origin, date, source, and edit/delete controls."},
      {id:"separate",title:"Separate AI-saved notes",detail:"Keep Personal Memory only for entries typed in Sherry and add a distinct list for AI-saved notes."}
    ],
    recommendation:"Bring explicit notes together but label who saved each one. A user should not have to know the backend distinction to find a note."
  },
  connected: {
    card:"The graph opens chat nodes, but a line is not yet a clear explanation of why two conversations are related.",
    reason:"The current graph is an exploratory way to reach conversations. The user previously rejected weak links and topic-only nodes. A connection must tell a person what evidence joins the chats; otherwise a visual network can imply more meaning than the data supports. It must never be read as a factual conflict.",
    question:"Is the canvas still the best primary way to explore related chats, or would a simpler related-chats list make the relationship clearer?",
    options:[
      {id:"graph",title:"Keep the graph",detail:"Keep pan and zoom, but show a plain-language reason and source evidence for each connection."},
      {id:"list",title:"Use related-chat lists",detail:"Show related chats beside each conversation; keep the canvas as an optional overview."},
      {id:"pause",title:"Pause this surface",detail:"Hide relationship browsing until connection quality is strong enough to explain."}
    ],
    recommendation:"Keep the canvas only if each edge can be explained. Otherwise the useful part is the related chat itself, not the network drawing."
  },
  projects: {
    card:"Project scopes exist in product and backend plans, but a user cannot create or manage projects in this web app.",
    reason:"Several chats may concern different projects. Organizing and retrieving them in one undifferentiated space can mix contexts that should remain separate. A project is more than a folder: it may affect which sources an AI can retrieve. That access rule needs to be settled before the UI promises project isolation.",
    question:"Should projects become a first-class destination, or a scope/filter applied inside current pages?",
    options:[
      {id:"destination",title:"Projects as a destination",detail:"Give each project its own sources, notes, activity, and retrieval permissions."},
      {id:"scope",title:"Projects as a scope switcher",detail:"Keep today's pages but let the user switch between personal and project contexts."},
      {id:"later",title:"Defer project UI",detail:"Do not introduce project navigation until scope rules and real user needs are validated."}
    ],
    recommendation:"Define the access boundary first. A scope switcher may be simpler than duplicating the whole navigation for every project."
  },
  retrieval: {
    card:"Settings can allow an AI to search or save notes, but it is not a full connect/disconnect or account-management flow.",
    reason:"‘Allow search’ controls access to Sherry context; ‘Allow explicit notes’ permits a connected AI to save a user-requested note. These permissions are separate from whether a browser extension is capturing chats. The current Settings section exposes the toggles and an MCP test, but it does not explain multiple accounts for the same provider or provide full connection lifecycle controls.",
    question:"Where should people manage AI access so it is clearly distinct from browser capture?",
    options:[
      {id:"settings",title:"Keep access in Settings",detail:"Make the two permissions clearer here; manage capture surfaces in Diagnostics or Connections."},
      {id:"connections",title:"Move access to Connections",detail:"Put each provider account, its permissions, and its connection state in one destination."}
    ],
    recommendation:"Keep permissions in Settings until there is a real account-connection flow, then make Connections the home for each provider account."
  },
  inspection: {
    card:"A test query shows a result now; there is no user-facing record of what a real connected AI received.",
    reason:"An aggregate retrieval count does not answer ‘what did Claude or ChatGPT actually see about me?’ A useful inspection view would show the request time, provider, returned sources, permission/scope, and whether content was shortened. Storing and exposing full query text could introduce privacy risk, so this needs a deliberate data boundary.",
    question:"Should people be able to inspect individual retrieval events, or is an on-demand test tool enough for the MVP?",
    options:[
      {id:"history",title:"Per-request history",detail:"List individual retrievals with source provenance and truncation, without unnecessarily storing sensitive query text."},
      {id:"test-only",title:"On-demand test only",detail:"Improve the existing test result but do not create an ongoing retrieval history yet."}
    ],
    recommendation:"Design the event shape now and evaluate it in Gate 10. Do not promise a complete history until the data is actually recorded and privacy-tested."
  },
  connections: {
    card:"Extension controls and AI permissions are split; multiple accounts per provider have no dedicated user view yet.",
    reason:"A person may have two ChatGPT accounts, a Claude account, and one or more browsers. Each can have different capture status and retrieval rights. Today the extension lives in Diagnostics while AI retrieval settings live in Settings. Those are different technical systems, but a user still needs to understand which account or browser contributed a memory.",
    question:"Should there be one Connections home that groups provider accounts and capture devices, while keeping their permissions distinct?",
    options:[
      {id:"home",title:"Unified Connections home",detail:"Show provider accounts, browser/device capture, status, and access rules in one place with clear subsections."},
      {id:"split",title:"Improve the current split",detail:"Keep AI access in Settings and extension controls in Diagnostics, with clearer labels and links."},
      {id:"later",title:"Defer account management",detail:"Document the model now but wait until multi-account capture is supported."}
    ],
    recommendation:"Plan a Connections home, but do not merge capture and retrieval into one ambiguous switch. Multiple accounts are a later milestone."
  },
  summarization: {
    card:"A user can configure summary timing and run a summary, but failure and freshness are hard to interpret.",
    reason:"A chat may have newer messages than its last summary; a provider key may fail; or Sherry may skip an unchanged input to avoid another paid model call. The configuration controls live in Settings, while the actual summary is inside the chat. The experience should connect those two facts in plain language.",
    question:"Where should a user understand a chat's summary status, versus where should they change the global summarizer settings?",
    options:[
      {id:"split",title:"Status in chat, setup in Settings",detail:"Show fresh/pending/failed beside the chat summary and keep model/key controls in Settings."},
      {id:"central",title:"Central processing view",detail:"Add a broader queue/status view for all conversations, with settings linked from there."}
    ],
    recommendation:"Keep configuration in Settings and explain freshness or failure on the affected chat. A global queue can remain technical Diagnostics until needed."
  },
  import: {
    card:"History import exists, but full workspace export, clear partial results, and imported artifact handling remain incomplete.",
    reason:"Importing an official provider export can overlap with extension-captured chats, contain unsupported records, and reference artifacts whose files were not uploaded. Export currently downloads conversations, not every Sherry note and setting. Calling it a workspace export without that boundary can give false confidence in a backup.",
    question:"Should import/export remain a subsection of Account & data, or become a guided data-migration flow with preview and recovery?",
    options:[
      {id:"guided",title:"Guided import flow",detail:"Preview counts, overlap, unsupported items, progress, and failures before confirming; keep export nearby."},
      {id:"settings",title:"Keep compact Settings controls",detail:"Improve labels and result messages without introducing a larger flow yet."}
    ],
    recommendation:"Use a guided import flow because overlap and partial results require informed consent. State the export contents precisely until full backup exists."
  },
  deletion: {
    card:"A user can delete a chat, summary, or personal note; whole-workspace deletion is not functional yet.",
    reason:"Deletion is a trust claim, not only a button. A person needs to know whether Sherry removes the transcript, summaries, index entries, archives, and future recaptures—and that deleting from Sherry does not delete the original chat at the provider. Gate 9 must verify the backend propagation before UI can truthfully say ‘complete.’",
    question:"Where should full-workspace deletion and retention choices live, and how much of the impact must be shown before confirmation?",
    options:[
      {id:"account",title:"Account & data flow",detail:"Keep the entry in Settings and use a dedicated review/confirmation flow with a clear deletion result."},
      {id:"data-center",title:"Separate data-control area",detail:"Give export, retention, and deletion a more prominent destination outside general Settings."}
    ],
    recommendation:"Keep this under Account & data, but give deletion its own careful confirmation and result sequence. Do not release it before the Gate 9 propagation check."
  },
  diagnostics: {
    card:"Diagnostics brings cloud status and extension controls together, but some failures still need clearer user-facing recovery steps.",
    reason:"This page is useful for troubleshooting, especially capture, upload, and summary errors. It also holds extension settings because those controls should not live on a separate diagnostic website. The risk is that ordinary actions such as pausing capture feel hidden inside a technical page, while detailed event logs can overwhelm everyday users.",
    question:"Should Diagnostics remain a top-level destination, or should ordinary capture controls move to a Connections area while technical details stay here?",
    options:[
      {id:"split",title:"Everyday controls elsewhere",detail:"Put account/device capture controls in Connections; keep failures and technical events in Diagnostics."},
      {id:"combined",title:"Keep one Diagnostics page",detail:"Retain the current destination, but clearly separate everyday controls from technical evidence."}
    ],
    recommendation:"Keep the current page for now; plan to move everyday connection controls only when a real Connections home exists."
  }
};

const flows = [
  {title:"First use",purpose:"A new person wants to connect one AI chat and know that Sherry captured it safely.",steps:["signin","onboarding","connections","diagnostics","chats"],gap:"Today, only existing users can sign in. There is no guided account setup, connection consent, or first-capture confirmation."},
  {title:"Find and understand a chat",purpose:"A person sees a recent chat and asks what Sherry stored, when it changed, and where it came from.",steps:["dashboard","chats","sources","timeline"],gap:"Dashboard and chat detail work. A cross-source library and a readable activity history are still decisions, not pages."},
  {title:"Correct what Sherry remembers",purpose:"A person finds an inaccurate summary or note and wants to correct it without rewriting the original chat.",steps:["chats","personal","timeline"],gap:"Summary and personal-note editing exist. A user-facing record of edits beyond summary versions does not."},
  {title:"Explore related conversations",purpose:"A person wants to follow a meaningful relationship between two chats and understand why they connect.",steps:["connected","chats","inspection"],gap:"The graph reaches chat detail, but the reason for each relationship and its relevance to retrieval remain unclear."},
  {title:"Let an AI use Sherry",purpose:"A person lets one AI retrieve context and wants to know exactly what that AI was allowed to see.",steps:["retrieval","inspection","chats"],gap:"Permission controls and test queries exist. A real per-request explanation of returned sources and account scope does not."},
  {title:"Bring data in or take it out",purpose:"A person imports an older provider archive and needs to understand overlap, missing files, and what a Sherry export contains.",steps:["import","chats","sources","diagnostics"],gap:"Imports and conversation export exist, but full-workspace backup and reliable partial-import recovery do not."},
  {title:"Pause, diagnose, or delete",purpose:"A person stops capture, fixes a failure, or removes data and expects a trustworthy confirmation.",steps:["diagnostics","connections","deletion","timeline"],gap:"Extension controls and individual deletion exist. Full-workspace deletion, disconnect, and proven removal across all copies do not."}
];

const states = [
  ["Sign-in / session expired","Explain whether to sign in again and preserve the intended destination.","partial","What should happen to an open detail when a session expires?"],
  ["First-use empty workspace","Offer connect/import/first-note paths without invented activity.","missing","What is the single best first action?"],
  ["Loading / slow request","Show what is being fetched and when to retry safely.","partial","When should a loading state become a delay warning?"],
  ["Dashboard with real data","Show metric scope and clickable underlying records.","covered","Which metrics need provenance before being trusted?"],
  ["Dashboard no data / no retrieval history","Separate zero activity from missing telemetry.","partial","Should no-history cards explain what enables collection?"],
  ["Chat search: zero results","Keep filters visible and provide a reset route.","partial","How should zero results differ from an empty workspace?"],
  ["Chat detail: partial transcript","Explain known coverage without presenting a guessed full conversation.","partial","What evidence is enough to label a source incomplete?"],
  ["Chat detail: source unavailable","Keep the stored copy useful and explain why original link fails.","missing","Is the link expired, private, deleted, or unknown?"],
  ["Capture paused / extension absent","Show where collection stopped and how to resume.","partial","Is the status browser-specific or workspace-wide?"],
  ["Permission denied / revoked","Name the affected provider and give a safe permission path.","missing","Which permission can be retried in-app?"],
  ["Pending local upload / offline","Distinguish safely queued data from lost data.","partial","What is the source of truth for pending counts?"],
  ["Upload failed / retrying","Show retry state without duplicate or silent loss claims.","partial","When should a retry require user action?"],
  ["Summary pending / chat still active","Show that capture can be newer than the last summary.","partial","How should the latest summary time compare with chat time?"],
  ["Summary failed / model call blocked","Give the exact reason and safe next step.","partial","Which errors are configuration, unchanged-input protection, or provider failure?"],
  ["Retrieval permission off","Explain that this AI cannot search or save notes.","partial","Where does read permission differ from explicit-note write permission?"],
  ["Retrieval stale / no result","Differentiate delayed index from no matching source.","partial","Which freshness signal can the user trust?"],
  ["Retrieval truncated","Show omitted content and accessible source links.","missing","What should the limit and evidence view reveal?"],
  ["Import preview / overlap","Count new, duplicate, and uncertain records before commit.","partial","How should non-text content and source dates appear?"],
  ["Import partially failed / undo","Show exactly which chats landed and a bounded recovery action.","missing","What is the unit of rollback: chat or import batch?"],
  ["Export incomplete / failed","State what is included and recover from a failed download.","partial","Should the full export package include explicit notes, metadata, and artifacts?"],
  ["Delete confirmation / in progress","Name the scope and prevent accidental double submission.","partial","How should linked summaries and indexes be previewed?"],
  ["Delete completed / partial / recaptured","Prove what was removed and show remediation if a copy survives.","missing","Which systems must agree before completion is shown?"],
  ["Project or account scope mismatch","Show when a source is hidden by project or provider account.","missing","How can a user switch scope without widening access accidentally?"],
  ["Graph empty / weak or unexplained link","Explain why two chats connect and how to reach the source.","partial","What minimum evidence makes a connection useful?"],
  ["Personal Memory save/edit/delete","Show saved state and undo or clear failure recovery.","partial","Should explicit AI-written notes carry a distinct origin label?"],
  ["Small screen / keyboard / assistive tech","Navigate and read all states on intended surfaces.","partial","Accessibility verification is intentionally deferred for now."]
].map((row,index)=>({id:`state-${index+1}`,surface:row[0],need:row[1],coverage:row[2],question:row[3]}));

const stateExamples = [
  "A saved chat link is opened after the user's session expires.",
  "A new workspace has no captured chats or notes yet.",
  "A conversation detail takes long enough that the user wonders whether it failed.",
  "A dashboard card says six chats and opens the exact six records it counted.",
  "A retrieval card shows zero even though no provider has used retrieval yet.",
  "A search finds nothing because a date filter is still active.",
  "The extension captured only the newest visible portion of a long conversation.",
  "The original provider chat was deleted or its URL no longer opens.",
  "Capture was turned off in one browser while another browser is still active.",
  "The browser revokes Sherry's permission to read a supported AI site.",
  "Messages are queued on a laptop that has gone offline.",
  "An upload failed once and Sherry is retrying without creating copies.",
  "A chat was updated today, but its latest summary is from yesterday.",
  "The same model input previously failed, so Sherry avoids another paid call.",
  "Claude may search but is not allowed to save an explicit note.",
  "A search returns nothing because indexing is delayed, not because no source matches.",
  "A result was shortened by a context limit, but its source remains available.",
  "A Claude export includes chats already captured by the extension.",
  "Half of an import succeeds before one malformed record stops the rest.",
  "A user downloads ‘workspace export’ expecting notes, but it contains conversations only.",
  "A user removes one chat and needs to know what linked copies will also go.",
  "A deleted chat still appears in search or is captured again later.",
  "Two accounts with the same AI provider should not be mistaken for one source.",
  "Two chat nodes have a line between them but the reason is unclear.",
  "A user edits a note and wants to know whether the save actually succeeded.",
  "A narrow screen or keyboard-only visit reaches the same information."
];
states.forEach((state,index)=>state.example=stateExamples[index]);

const $ = id => document.getElementById(id);
const byId = Object.fromEntries(areas.map(area=>[area.id,area]));
const storageKey = "sherry-gate-8-ia-review-v1";
let feedback = {};
let activeId = null;
let stateFilter = "all";
try { feedback = JSON.parse(localStorage.getItem(storageKey) || "{}"); } catch { feedback = {}; }
const legacyChoices = {keep:"not-needed",change:"next",add:"next",defer:"later"};
for(const value of Object.values(feedback)) if(value && legacyChoices[value.choice]) value.choice=legacyChoices[value.choice];

function saveFeedback(){
  try { localStorage.setItem(storageKey,JSON.stringify(feedback)); $("saveStatus").textContent="Saved locally as you type."; }
  catch { $("saveStatus").textContent="Browser storage is unavailable. Download your review before closing this page."; }
  renderReview();
}

function button(label, className, handler){
  const element=document.createElement("button");
  element.type="button"; element.className=className; element.textContent=label; element.addEventListener("click",handler);
  return element;
}

function renderMap(){
  const map=$("map"); map.replaceChildren();
  const showFuture=$("showFuture").checked;
  for(const group of ["Entry","Explore","Organize","Connect","Control","Support"]){
    const items=areas.filter(area=>area.group===group && area.status!=="retired" && (showFuture || area.status!=="proposed"));
    if(!items.length) continue;
    const section=document.createElement("section"); section.className="map-group";
    const heading=document.createElement("h3"); heading.textContent=group; section.append(heading);
    const list=document.createElement("div"); list.className="map-items";
    for(const area of items){
      const context=reviewContext[area.id];
      const item=button("",`map-item ${area.status}`,()=>openDetail(area.id));
      const title=document.createElement("strong"); title.textContent=area.title;
      const sub=document.createElement("span"); sub.textContent=context.card;
      const prompt=document.createElement("em"); prompt.textContent=`Decide: ${context.question}`;
      item.append(title,sub,prompt); list.append(item);
    }
    section.append(list); map.append(section);
  }
}

function renderFlows(){
  const list=$("flowList"); list.replaceChildren();
  for(const flow of flows){
    const article=document.createElement("article"); article.className="flow";
    const head=document.createElement("div"); head.className="flow-head";
    const copy=document.createElement("div"); const title=document.createElement("h3"); title.textContent=flow.title;
    const purpose=document.createElement("p"); purpose.textContent=flow.purpose; copy.append(title,purpose);
    const count=document.createElement("small"); count.textContent=`${flow.steps.length} touchpoints`;
    head.append(copy,count); article.append(head);
    const steps=document.createElement("div"); steps.className="flow-steps";
    flow.steps.forEach((id,index)=>{
      if(index){const arrow=document.createElement("span"); arrow.className="arrow"; arrow.textContent="→"; arrow.setAttribute("aria-hidden","true"); steps.append(arrow);}
      const area=byId[id]; const step=button(area.title,`flow-step ${area.status}`,()=>openDetail(id));
      const tag=document.createElement("small"); tag.textContent=area.status==="live"?"In app now":area.status==="partial"?"Partial":"Proposed"; step.append(tag); steps.append(step);
    });
    article.append(steps); const gap=document.createElement("div"); gap.className="flow-gap"; gap.textContent=`Missing today: ${flow.gap}`; article.append(gap); list.append(article);
  }
}

function renderStates(){
  const tbody=$("stateRows"); tbody.replaceChildren();
  for(const state of states.filter(item=>stateFilter==="all"||item.coverage===stateFilter)){
    const row=document.createElement("tr");
    const moment=document.createElement("td"); moment.textContent=state.surface;
    const example=document.createElement("small"); example.className="state-example"; example.textContent=`Example: ${state.example}`; moment.append(example); row.append(moment);
    const need=document.createElement("td"); need.textContent=state.need; row.append(need);
    const coverage=document.createElement("td"); const badge=document.createElement("span"); badge.className=`coverage ${state.coverage}`; badge.textContent=state.coverage==="covered"?"Present":state.coverage==="partial"?"Partial / unverified":"Not built"; coverage.append(badge); row.append(coverage);
    const question=document.createElement("td"); question.textContent=state.question; row.append(question); tbody.append(row);
  }
}

function openDetail(id){
  const area=byId[id]; const context=reviewContext[id]; activeId=id;
  $("detailTitle").textContent=area.title;
  $("detailStatus").textContent=area.status==="live"?"In app now":area.status==="partial"?"Partial":"Proposed";
  $("detailSummary").textContent=area.summary;
  $("detailLocation").textContent=area.location;
  $("detailNow").textContent=area.now;
  $("detailReason").textContent=context.reason;
  $("detailQuestion").textContent=context.question;
  $("detailRecommendation").textContent=context.recommendation;
  $("detailNext").textContent=area.next;
  $("detailGate").textContent=area.gate;
  const options=$("detailOptions"); options.replaceChildren();
  for(const option of context.options){
    const selected=feedback[id]?.direction===option.id;
    const item=button("",`option ${selected?"selected":""}`,()=>{
      feedback[id]={...(feedback[id]||{}),direction:feedback[id]?.direction===option.id?null:option.id};
      Array.from(options.children).forEach(child=>{child.classList.toggle("selected",child.dataset.option===feedback[id].direction);child.setAttribute("aria-pressed",child.dataset.option===feedback[id].direction);});
      saveFeedback();
    });
    item.dataset.option=option.id; item.setAttribute("aria-pressed",selected);
    const title=document.createElement("strong"); title.textContent=option.title;
    const description=document.createElement("span"); description.textContent=option.detail;
    item.append(title,description); options.append(item);
  }
  $("reviewNote").value=feedback[id]?.note||"";
  document.querySelectorAll("[data-choice]").forEach(choice=>choice.classList.toggle("selected",choice.dataset.choice===feedback[id]?.choice));
  $("detailDialog").showModal();
}

function renderReview(){
  const entries=Object.entries(feedback).filter(([id,value])=>reviewContext[id] && (value.direction || value.choice || value.note?.trim()));
  $("reviewCount").textContent=entries.length;
  const list=$("reviewItems"); list.replaceChildren();
  if(!entries.length){const empty=document.createElement("p"); empty.className="review-empty"; empty.textContent="No decisions yet. Choose an area on the Sitemap or User flows tab to leave your notes."; list.append(empty); return;}
  for(const [id,value] of entries){
    const item=button(byId[id].title,"review-item",()=>openDetail(id));
    const left=document.createElement("div"); const title=document.createElement("strong"); title.textContent=byId[id].title; left.append(title);
    const direction=reviewContext[id].options.find(option=>option.id===value.direction);
    if(direction){const selected=document.createElement("p");selected.textContent=`Direction: ${direction.title}`;left.append(selected);}
    if(value.note?.trim()){const note=document.createElement("p"); note.textContent=value.note; left.append(note);}
    const decision=document.createElement("small"); decision.textContent=({next:"First in 8C",later:"Later","not-needed":"Not needed",unsure:"Need more discussion"}[value.choice]) || "No priority set";
    item.append(left,decision); list.append(item);
  }
}

document.querySelectorAll("[data-tab]").forEach(tab=>tab.addEventListener("click",()=>{
  document.querySelectorAll("[data-tab]").forEach(other=>{const selected=other===tab; other.classList.toggle("active",selected); other.setAttribute("aria-pressed",selected);});
  for(const name of ["map","flows","states","review"]){$(name+"Panel").hidden=name!==tab.dataset.tab;}
}));
document.querySelectorAll("[data-state-filter]").forEach(filter=>filter.addEventListener("click",()=>{
  stateFilter=filter.dataset.stateFilter;
  document.querySelectorAll("[data-state-filter]").forEach(other=>{const selected=other===filter;other.classList.toggle("active",selected);other.setAttribute("aria-pressed",selected);});
  renderStates();
}));
$("showFuture").addEventListener("change",renderMap);
$("closeDetail").addEventListener("click",()=>$("detailDialog").close());
$("detailDialog").addEventListener("click",event=>{if(event.target===$("detailDialog")) $("detailDialog").close();});
document.querySelectorAll("[data-choice]").forEach(choice=>choice.addEventListener("click",()=>{
  const current=feedback[activeId]||{}; current.choice=current.choice===choice.dataset.choice?null:choice.dataset.choice; feedback[activeId]=current;
  document.querySelectorAll("[data-choice]").forEach(other=>other.classList.toggle("selected",other.dataset.choice===current.choice)); saveFeedback();
}));
$("reviewNote").addEventListener("input",()=>{if(!activeId)return;feedback[activeId]={...(feedback[activeId]||{}),note:$("reviewNote").value};saveFeedback();});
$("exportReview").addEventListener("click",()=>{
  const decisions=Object.entries(feedback).filter(([id,value])=>reviewContext[id]&&(value.direction||value.choice||value.note?.trim())).map(([id,value])=>({area:id,title:byId[id].title,direction:value.direction||null,directionLabel:reviewContext[id].options.find(option=>option.id===value.direction)?.title||null,priority:value.choice||null,note:value.note||""}));
  const payload={product:"Sherry",artifact:"Gate 8 information architecture review",version:2,exportedAt:new Date().toISOString(),decisions};
  const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:"application/json"}));
  const link=document.createElement("a");link.href=url;link.download="sherry-gate-8-ia-review.json";document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
});

renderMap(); renderFlows(); renderStates(); renderReview();
