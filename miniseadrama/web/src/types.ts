export interface EpisodeInfo {
  number: number;
  title: string;
  duration: number;
  qualities?: string[];
}

export interface SeriesInfo {
  title: string;
  slug: string;
  source_url: string;
  episode_count: number;
  episodes: EpisodeInfo[];
}

export interface ProgressState {
  stage: string;
  stage_label: string;
  overall: number;
  total_episodes: number;
  downloaded: number;
  transcribed: number;
  current_episode: number | null;
  script_batch: number;
  script_batches: number;
}

export interface Artifact {
  key: string;
  label: string;
  path: string;
}

export interface ScriptResult {
  title_cn?: string;
  title_en?: string;
  episode_count?: number;
  plan_json?: string;
  script_md?: string;
  script_docx?: string;
  setting_docx?: string;
  rating?: {
    grade?: string;
    score?: number;
  };
}

export interface JobResult {
  workdir: string;
  series: {
    title: string;
    slug: string;
    source_url: string;
    episode_count: number;
  };
  transcript_txt: string;
  series_srt: string;
  prompt_bundle: string;
  episodes_json: string;
  script?: ScriptResult | null;
  script_error?: string | null;
  artifacts: Artifact[];
}

export interface JobEvent {
  seq: number;
  at: number;
  type: string;
  message: string;
  progress?: ProgressState;
  series?: SeriesInfo;
  result?: JobResult;
  artifacts?: Artifact[];
}

export interface JobSummary {
  id: string;
  status: string;
  message: string;
  created_at: number;
  updated_at: number;
  params: Record<string, unknown>;
  progress: ProgressState;
  result: JobResult | null;
  error: string | null;
  event_seq: number;
}

export interface Defaults {
  version: string;
  ffmpeg_path: string | null;
  saved_ffmpeg_path: string | null;
  output_root: string;
  engines: { value: string; label: string }[];
  default_engine: string;
  skill_present: boolean;
  stages: Record<string, string>;
}
