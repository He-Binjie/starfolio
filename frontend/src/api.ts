export interface SourceInfo {
  id: string;
  name: string;
  path: string;
  kind: 'wiki' | 'portal' | 'archive' | 'folder' | 'files';
  is_git: boolean;
  sensitivity: 'work' | 'personal' | 'system';
}

export interface ActorInfo {
  id: string;
  label: string;
  color: string;
}

export interface ProjectInfo {
  source_id: string;
  project: string;
  doc_count: number;
  last_mtime: number;
}

export interface IndexStatus {
  progress: {
    running: boolean;
    current_source: string;
    files_scanned: number;
    files_indexed: number;
    files_skipped: number;
    files_failed: number;
    last_finished_at: string | null;
    last_error: string;
  };
  totals: { documents: number; chunks: number };
  by_source: Array<{ source_id: string; docs: number; chunks: number; failed: number }>;
  by_ext: Array<{ ext: string; docs: number }>;
  last_run: Record<string, any> | null;
  non_ok_files: Array<{ source_id: string; rel_path: string; parse_status: string; parse_note: string }>;
}

export interface VectorStatus {
  enabled: boolean;
  model_name: string;
  model_loaded: boolean;
  idle_unload_seconds: number;
  total_chunks: number;
  embedded_chunks: number;
  unique_vectors: number;
  coverage_pct: number;
  progress: {
    running: boolean;
    done_in_run: number;
    total_in_run: number;
    chunks_per_sec: number;
    last_finished_at: string | null;
    last_error: string;
  };
}

export interface QaEngineInfo {
  id: string;
  label: string;
  provider: string;
  mode: 'fast' | 'deep';
  model: string;
  note: string;
  available: boolean;
  is_default: boolean;
}

export interface QaEvidenceItem {
  ref: number;
  chunk_id: number | null;
  source_id: string;
  rel_path: string;
  project: string;
  title: string;
  ext: string;
  heading_path: string;
  start_line: number;
  end_line: number;
  page_num: number | null;
  match_type: string;
  vec_score: number | null;
  git_author: string;
  git_date: string;
  content: string;
}

export interface QaAudit {
  cited_refs: number[];
  invalid_refs: number[];
  substantive_lines?: number;
  cited_lines?: number;
  citation_ratio: number;
  uncited_lines: string[];
  number_warnings: Array<{ number: string; sentence: string; refs: number[] }>;
}

export interface QaRecord {
  id: number | null;
  created_at?: string;
  status: string;
  question: string;
  engine_id: string;
  engine_label: string;
  source_id: string;
  project: string;
  answer: string;
  evidence: QaEvidenceItem[];
  audit: QaAudit;
  duration_ms: number;
  error: string;
}

export interface ConflictCandidate {
  id: number;
  pair_key: string;
  source_id: string;
  project: string;
  rel_path_a: string;
  title_a: string;
  start_line_a: number;
  end_line_a: number;
  snippet_a: string;
  rel_path_b: string;
  title_b: string;
  start_line_b: number;
  end_line_b: number;
  snippet_b: string;
  similarity: number;
  diff_tokens: { only_a?: string[]; only_b?: string[]; dates_a?: string[]; dates_b?: string[] };
  diff_summary: string;
  priority_score: number;
  status: string;
  llm_verdict: string;
  llm_reason: string;
  fix_prompt: string;
}

export interface MetaResponse {
  name: string;
  version: string;
  platform?: string;
  edition?: 'personal' | 'standalone';
  onboarding_completed?: boolean;
  is_first_run?: boolean;
  data_dir?: string;
  read_only: boolean;
  watcher_active?: boolean;
  sources: SourceInfo[];
  actors: ActorInfo[];
  projects: ProjectInfo[];
  qa_engines?: QaEngineInfo[];
  index_status: IndexStatus;
  vector_status?: VectorStatus;
}

export interface SettingsResponse {
  edition: 'personal' | 'standalone';
  onboarding_completed: boolean;
  config_path: string;
  data_dir: string;
  sample_available: boolean;
  allowed_extensions?: string[];
  sources: Array<{
    id: string;
    name: string;
    path: string;
    kind: string;
    is_git: boolean;
    exists: boolean;
    files?: string[];
  }>;
  openai_api: {
    enabled: boolean;
    base_url: string;
    model: string;
    api_key_set: boolean;
    api_key_hint: string;
  };
  exclude_keywords: string[];
}

export interface TreeNode {
  key: string;
  title: string;
  isLeaf: boolean;
  source_id: string;
  rel_path?: string;
  project?: string;
  ext?: string;
  count?: number;
  children?: TreeNode[];
}

export type SearchMode = 'hybrid' | 'fts' | 'semantic';

export interface SearchHit {
  doc_id: number;
  chunk_id: number | null;
  source_id: string;
  rel_path: string;
  project: string;
  title: string;
  ext: string;
  heading_path: string;
  start_line: number;
  end_line: number;
  page_num: number | null;
  snippet: string;
  score: number;
  match_type?: 'both' | 'fts' | 'semantic' | 'recent';
  vec_score?: number | null;
  is_historical?: boolean;
  mtime: number;
  git_author: string;
  git_date: string;
  parse_note: string;
}

export interface QuickJumpResponse {
  documents: Array<{
    source_id: string;
    rel_path: string;
    project: string;
    title: string;
    ext: string;
    mtime: number;
    git_author: string;
    is_historical: boolean;
  }>;
  projects: Array<{
    source_id: string;
    project: string;
    doc_count: number;
    last_mtime: number;
  }>;
}

export interface SearchResponse {
  query: string;
  mode: 'hybrid' | 'fts' | 'semantic' | 'recent';
  total: number;
  items: SearchHit[];
}

export interface DocumentDetail {
  meta: {
    source_id: string;
    rel_path: string;
    abs_path: string;
    project: string;
    title: string;
    ext: string;
    size_bytes: number;
    mtime: number;
    parse_status: string;
    parse_note: string;
    git_author: string;
    git_date: string;
    git_message: string;
  };
  is_text: boolean;
  raw_content: string;
  chunks: Array<{
    id: number;
    chunk_index: number;
    heading_path: string;
    start_line: number;
    end_line: number;
    page_num: number | null;
    content: string;
  }>;
  git_history: Array<{ hash: string; author: string; date: string; message: string }>;
}

export interface RelatedDocItem {
  source_id: string;
  rel_path: string;
  project: string;
  title: string;
  ext: string;
  mtime: number;
  git_date: string;
  similarity: number;
  is_historical: boolean;
  best_heading: string;
  best_start_line: number;
  best_end_line: number;
  best_page_num: number | null;
}

export interface ProjectOverviewItem {
  source_id: string;
  source_name: string;
  source_kind: string;
  project: string;
  display_name: string;
  doc_count: number;
  counts: {
    decisions: number;
    prds: number;
    meetings: number;
    todos: number;
    references: number;
  };
  last_mtime: number;
  last_author: string;
  last_date: string;
}

export interface ProjectDocRow {
  id: number;
  source_id: string;
  rel_path: string;
  title: string;
  ext: string;
  size_bytes: number;
  mtime: number;
  chunk_count: number;
  git_author: string;
  git_date: string;
  git_message: string;
  linked_from_global_meetings?: boolean;
}

export interface ProjectDetailResponse {
  source_id: string;
  source_name: string;
  project: string;
  display_name: string;
  total_docs: number;
  buckets: {
    index: ProjectDocRow[];
    decisions: ProjectDocRow[];
    prds: ProjectDocRow[];
    meetings: ProjectDocRow[];
    todos: ProjectDocRow[];
    references: ProjectDocRow[];
  };
  recent_commits: Array<{
    commit: string;
    actor: string;
    date: string;
    message: string;
  }>;
}

export interface TopicClusterDoc {
  source_id: string;
  source_name: string;
  rel_path: string;
  project: string;
  title: string;
  ext: string;
  mtime: number;
  git_date: string;
  centrality: number;
}

export interface TopicCluster {
  id: string;
  title: string;
  keywords: string[];
  doc_count: number;
  cohesion: number;
  ext_counts: Record<string, number>;
  last_mtime: number;
  docs: TopicClusterDoc[];
}

export interface TopicClustersResponse {
  total_docs: number;
  clusters: TopicCluster[];
}

export interface CollectionItem {
  id: number;
  name: string;
  description: string;
  docs: Array<{ source_id: string; rel_path: string; title: string }>;
  doc_count: number;
  created_at: string;
  updated_at: string;
}

export interface CompareDocsResponse {
  doc_a: DocumentDetail;
  doc_b: DocumentDetail;
  diff: {
    only_a_quants: string[];
    only_b_quants: string[];
    shared_quants: string[];
    dates_a: string[];
    dates_b: string[];
    actions_a: string[];
    actions_b: string[];
  };
}

export interface FactMatrixItem {
  source_id: string;
  rel_path: string;
  title: string;
  ext: string;
  mtime: number;
  git_date: string;
  quants: string[];
  unique_quants: string[];
  shared_quants: string[];
  quant_contexts: Array<{ line: number; tokens: string[]; text: string }>;
  dates: string[];
  actions: string[];
}

export interface FactMatrixResponse {
  doc_count: number;
  items: FactMatrixItem[];
}

export interface LineageNode {
  source_id: string;
  rel_path: string;
  title: string;
  ext: string;
  project: string;
  stage: string;
  stage_label: string;
  mtime: number;
  edge_type: 'explicit' | 'version' | 'semantic';
  edge_label: string;
  confidence: number;
  reason?: string;
}

export interface DocumentLineageResponse {
  current: {
    source_id: string;
    rel_path: string;
    title: string;
    stage: string;
    stage_label: string;
    mtime: number;
  } | null;
  upstream: LineageNode[];
  downstream: LineageNode[];
  counts: {
    upstream: number;
    downstream: number;
    explicit: number;
    version: number;
    semantic: number;
  };
}

export interface StarMapLineageEdge {
  from: number;
  to: number;
  type: 'explicit' | 'version' | 'semantic';
  label: string;
  weight: number;
}

export interface StarMapNode {
  idx: number;
  source_id: string;
  source_name: string;
  rel_path: string;
  project: string;
  title: string;
  ext: string;
  mtime: number;
  centrality: number;
  cluster_id: string;
  color_idx: number;
  x: number;
  y: number;
  stage?: string;
  stage_label?: string;
}

export interface StarMapCluster {
  id: string;
  title: string;
  color_idx: number;
  doc_count: number;
  shown_count: number;
  keywords: string[];
  cx: number;
  cy: number;
  docs: TopicClusterDoc[];
}

export interface StarMapResponse {
  total_docs: number;
  clusters: StarMapCluster[];
  nodes: StarMapNode[];
  edges: Array<{ a: number; b: number; sim: number; cluster_id: string }>;
  lineage_edges?: StarMapLineageEdge[];
  lineage_stats?: { explicit: number; version: number; semantic: number };
}

export interface DuplicateDocRef {
  id?: number;
  source_id: string;
  rel_path: string;
  project?: string;
  title: string;
  ext: string;
  size_bytes: number;
  mtime: number;
}

export interface DuplicatesResponse {
  exact_count: number;
  near_count: number;
  exact_groups: Array<{
    content_hash: string;
    count: number;
    size_bytes: number;
    files: DuplicateDocRef[];
  }>;
  near_pairs: Array<{
    similarity: number;
    doc_a: DuplicateDocRef;
    doc_b: DuplicateDocRef;
  }>;
}

export interface TimelineEvent {
  id: string;
  kind: 'git_commit' | 'non_git' | 'file_mtime';
  actor: string;
  raw_actor: string;
  source_id: string;
  source_name: string;
  repo_root: string;
  commit: string;
  timestamp: string;
  message: string;
  paths: Array<{ path: string; status: string }>;
}

export interface TimelineResponse {
  total: number;
  actor_counts: Record<string, number>;
  items: TimelineEvent[];
}

export interface HealthResponse {
  edition?: 'personal' | 'standalone';
  alerts: {
    generated_at: string | null;
    count: number;
    items: Array<{ level: string; source: string; message: string; fix_prompt: string }>;
  };
  wiki_health: {
    timestamp: string | null;
    healthy: boolean | null;
    stats: Record<string, number>;
    issues: Array<{
      severity: string;
      repo: string;
      project: string;
      message: string;
      fix_prompt: string;
    }>;
  };
  uncommitted: Array<{
    source_id: string;
    source_name: string;
    repo_path: string;
    count: number;
    files: Array<{ status: string; path: string }>;
    fix_prompt: string;
  }>;
  skill_lint: {
    total_skills: number;
    skills_with_issues: number;
    top_items: Array<{
      name: string;
      lines: number;
      issue_count: number;
      issues: Array<{ code: string; detail: string }>;
      fix_prompt: string;
    }>;
  };
  stack_audit: {
    generated_at: string | null;
    counts: Record<string, any>;
  };
  index_status: IndexStatus;
  vector_status?: VectorStatus;
  watcher_active?: boolean;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

export const api = {
  meta: () => getJson<MetaResponse>('/api/meta'),
  tree: () => getJson<TreeNode[]>('/api/tree'),
  search: (params: {
    q?: string;
    source_id?: string;
    project?: string;
    ext?: string;
    days?: number;
    mode?: SearchMode;
    include_historical?: boolean;
    limit?: number;
  }) => {
    const sp = new URLSearchParams();
    if (params.q) sp.set('q', params.q);
    if (params.source_id && params.source_id !== 'all') sp.set('source_id', params.source_id);
    if (params.project && params.project !== 'all') sp.set('project', params.project);
    if (params.ext && params.ext !== 'all') sp.set('ext', params.ext);
    if (params.days) sp.set('days', String(params.days));
    if (params.mode) sp.set('mode', params.mode);
    if (params.include_historical) sp.set('include_historical', 'true');
    if (params.limit) sp.set('limit', String(params.limit));
    return getJson<SearchResponse>(`/api/search?${sp.toString()}`);
  },
  quickJump: (q: string) =>
    getJson<QuickJumpResponse>(`/api/quick-jump?q=${encodeURIComponent(q)}&limit=14`),
  document: (source_id: string, rel_path: string) =>
    getJson<DocumentDetail>(
      `/api/document?source_id=${encodeURIComponent(source_id)}&rel_path=${encodeURIComponent(rel_path)}`
    ),
  relatedDocuments: (source_id: string, rel_path: string, limit = 5) =>
    getJson<{ items: RelatedDocItem[] }>(
      `/api/document/related?source_id=${encodeURIComponent(source_id)}&rel_path=${encodeURIComponent(rel_path)}&limit=${limit}`
    ),
  documentLineage: (source_id: string, rel_path: string) =>
    getJson<DocumentLineageResponse>(
      `/api/document/lineage?source_id=${encodeURIComponent(source_id)}&rel_path=${encodeURIComponent(rel_path)}`
    ),
  openExternal: async (source_id: string, rel_path: string, mode: 'default' | 'finder' | 'typora') => {
    const res = await fetch('/api/open-external', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_id, rel_path, mode }),
    });
    return res.json();
  },
  systemPickPaths: async (mode: 'files' | 'folder') => {
    const res = await fetch('/api/system/pick-paths', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    return res.json() as Promise<{ ok: boolean; paths: string[]; error?: string }>;
  },
  projectsOverview: () => getJson<ProjectOverviewItem[]>('/api/projects/overview'),
  projectDetail: (source_id: string, project: string) =>
    getJson<ProjectDetailResponse>(
      `/api/projects/detail?source_id=${encodeURIComponent(source_id)}&project=${encodeURIComponent(project)}`
    ),
  projectClusters: (source_id?: string, max_clusters = 10) => {
    const sp = new URLSearchParams();
    if (source_id && source_id !== 'all') sp.set('source_id', source_id);
    sp.set('max_clusters', String(max_clusters));
    return getJson<TopicClustersResponse>(`/api/projects/clusters?${sp.toString()}`);
  },
  starMap: (source_id?: string, max_docs = 220, max_clusters = 8) => {
    const sp = new URLSearchParams();
    if (source_id && source_id !== 'all') sp.set('source_id', source_id);
    sp.set('max_docs', String(max_docs));
    sp.set('max_clusters', String(max_clusters));
    return getJson<StarMapResponse>(`/api/projects/starmap?${sp.toString()}`);
  },
  duplicates: (limit = 30) => getJson<DuplicatesResponse>(`/api/health/duplicates?limit=${limit}`),
  collections: () => getJson<CollectionItem[]>('/api/collections'),
  createCollection: async (payload: {
    name: string;
    description?: string;
    docs: Array<{ source_id: string; rel_path: string; title: string }>;
  }) => {
    const res = await fetch('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    return res.json() as Promise<CollectionItem>;
  },
  deleteCollection: async (id: number) => {
    const res = await fetch(`/api/collections/${id}/delete`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  compareDocs: async (source_a: string, path_a: string, source_b: string, path_b: string) => {
    const res = await fetch('/api/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_a, path_a, source_b, path_b }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    return res.json() as Promise<CompareDocsResponse>;
  },
  analyzeFacts: async (docs: Array<{ source_id: string; rel_path: string; title?: string }>) => {
    const res = await fetch('/api/analyze/facts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docs }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<FactMatrixResponse>;
  },
  timeline: (params: { actor?: string; source_id?: string; days?: number; limit?: number }) => {
    const sp = new URLSearchParams();
    if (params.actor && params.actor !== 'all') sp.set('actor', params.actor);
    if (params.source_id && params.source_id !== 'all') sp.set('source_id', params.source_id);
    if (params.days) sp.set('days', String(params.days));
    if (params.limit) sp.set('limit', String(params.limit));
    return getJson<TimelineResponse>(`/api/timeline?${sp.toString()}`);
  },
  commitDiff: (source_id: string, commit: string) =>
    getJson<{ commit: string; source_id: string; diff: string; truncated: boolean }>(
      `/api/timeline/diff?source_id=${encodeURIComponent(source_id)}&commit=${encodeURIComponent(commit)}`
    ),
  health: () => getJson<HealthResponse>('/api/health'),
  refreshIndex: async (force = false) => {
    const res = await fetch(`/api/index/refresh?force=${force}`, { method: 'POST' });
    return res.json();
  },
  indexStatus: () => getJson<IndexStatus>('/api/index/status'),
  vectorsStatus: () => getJson<VectorStatus>('/api/vectors/status'),
  syncVectors: async () => {
    const res = await fetch('/api/vectors/sync', { method: 'POST' });
    return res.json();
  },
  qaEngines: () => getJson<QaEngineInfo[]>('/api/qa/engines'),
  qaHistory: () => getJson<QaRecord[]>('/api/qa/history'),
  qaAsk: async (payload: {
    question: string;
    engine_id?: string;
    source_id?: string;
    project?: string;
    top_k?: number;
    include_historical?: boolean;
    selected_docs?: Array<{ source_id: string; rel_path: string }>;
    conversation_turns?: Array<{ question: string; answer: string }>;
  }): Promise<QaRecord> => {
    const res = await fetch('/api/qa/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
    return res.json();
  },
  conflicts: (includeDismissed = false) =>
    getJson<ConflictCandidate[]>(`/api/conflicts?include_dismissed=${includeDismissed}`),
  scanConflicts: async () => {
    const res = await fetch('/api/conflicts/scan', { method: 'POST' });
    return res.json();
  },
  reviewConflict: async (id: number, engine_id?: string) => {
    const res = await fetch(`/api/conflicts/${id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine_id }),
    });
    return res.json();
  },
  setConflictStatus: async (id: number, status: string) => {
    const res = await fetch(`/api/conflicts/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    return res.json();
  },
  settings: () => getJson<SettingsResponse>('/api/settings'),
  addSource: async (path: string, name?: string) => {
    const res = await fetch('/api/settings/sources/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, name }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    return res.json();
  },
  addPaths: async (paths: string[], name?: string) => {
    const res = await fetch('/api/settings/sources/add-paths', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths, name }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    return res.json() as Promise<{
      ok: boolean;
      changed: boolean;
      added_folders: string[];
      added_files: string[];
      already_existing: string[];
      skipped_unsupported: string[];
      not_found: string[];
    }>;
  },
  removePickedFile: async (file_path: string, source_id = 'picked-files') => {
    const res = await fetch('/api/settings/sources/remove-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_id, file_path }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    return res.json();
  },
  removeSource: async (source_id: string) => {
    const res = await fetch('/api/settings/sources/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_id }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    return res.json();
  },
  loadSampleKb: async () => {
    const res = await fetch('/api/settings/load-sample', { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    return res.json();
  },
  saveOpenAi: async (payload: {
    enabled: boolean;
    base_url: string;
    api_key: string;
    model: string;
    clear_key?: boolean;
  }) => {
    const res = await fetch('/api/settings/openai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  testOpenAi: async (payload: { base_url: string; api_key: string; model: string }) => {
    const res = await fetch('/api/settings/openai/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.json() as Promise<{ ok: boolean; latency_ms: number; reply?: string; error?: string }>;
  },
  saveExcludeKeywords: async (keywords: string[]) => {
    const res = await fetch('/api/settings/exclude-keywords', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  completeOnboarding: async (completed = true) => {
    const res = await fetch('/api/settings/onboarding-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ completed }),
    });
    return res.json();
  },
};
