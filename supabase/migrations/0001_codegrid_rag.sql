-- CodeGrid RAG — Card Schema v1
-- Two indexes over the ingested corpus:
--   components  — "assemble a whole site": retrieve a section, adapt it.
--   techniques  — "invent a new site": retrieve a technique, write fresh code.
-- Enum values MUST stay in sync with scripts/rag/schema.mjs (ENUMS) — the test
-- scripts/rag/schema.test.mjs asserts they never drift.
--
-- vector(1024) matches Voyage voyage-3 (the default embedding provider). If you
-- switch providers (e.g. OpenAI text-embedding-3-small = 1536), change EVERY
-- vector(1024) below to the new dimension and re-run. See docs/harness/rag.md.

create extension if not exists vector;

-- ---------- Enums (mirror scripts/rag/schema.mjs) ----------
create type comp_scope as enum ('section', 'global', 'overlay');

create type comp_type as enum (
  'nav', 'hero', 'about', 'work_grid', 'project_detail', 'gallery',
  'marquee', 'testimonial', 'pricing', 'faq', 'cta', 'contact',
  'footer', 'text_block', 'stats', 'team', 'process',
  'cursor', 'smooth_scroll', 'preloader', 'scroll_progress', 'audio_toggle',
  'menu', 'modal', 'lightbox', 'page_transition'
);

create type framework_type as enum ('vanilla', 'react', 'next', 'vue', 'svelte');

create type anim_lib as enum (
  'gsap', 'scrolltrigger', 'scrollsmoother', 'splittext', 'flip',
  'framer_motion', 'motion_one', 'anime',
  'lenis', 'locomotive',
  'three', 'ogl', 'curtains', 'pixi',
  'matter', 'cannon',
  'swiper', 'embla',
  'none'
);

create type css_approach_type as enum (
  'vanilla_css', 'tailwind', 'scss', 'css_modules', 'styled_components'
);

create type asset_type as enum ('image', 'video', 'font', 'model_3d', 'audio');

create type side_effect as enum (
  'body_overflow_lock', 'scroll_hijack', 'scrolltrigger_register', 'own_raf_loop',
  'resize_listener', 'wheel_listener', 'pointer_listener_global', 'fixed_layer',
  'history_api', 'canvas_fullscreen'
);

create type aesthetic_tag as enum (
  'brutalist', 'editorial', 'minimal', 'maximalist', 'swiss',
  'retro', 'organic', 'tech', 'luxury', 'playful', 'experimental'
);

create type motion_tag as enum (
  'scroll_driven', 'hover_driven', 'click_driven',
  'autoplay', 'physics', 'cursor_follow', 'static'
);

create type density_type    as enum ('sparse', 'balanced', 'dense');
create type color_mood      as enum ('dark', 'light', 'high_contrast', 'muted', 'vivid');
create type responsive_type as enum ('fluid', 'breakpoints', 'fixed', 'unknown');
create type coupling_type   as enum ('standalone', 'needs_siblings', 'needs_scroll_container');

-- ---------- Component index ----------
create table components (
  id              text primary key,             -- src_001 (== corpus project id)
  source_path     text not null,
  origin_site     text,                          -- NOT embedded (would bias retrieval to brand)
  loc             int,
  schema_version  int  not null default 1,
  annotator_model text,
  indexed_at      timestamptz default now(),

  -- HARD FILTERS -> WHERE
  scope           comp_scope     not null,
  comp_type       comp_type      not null,
  framework       framework_type not null,
  animation_libs  anim_lib[]     not null default '{}',
  css_approach    css_approach_type,
  needs_webgl     bool           not null default false,
  asset_types     asset_type[]   not null default '{}',
  side_effects    side_effect[]  not null default '{}',

  -- SOFT TAGS -> secondary filter + rerank
  aesthetic        aesthetic_tag[] not null default '{}',
  motion_character motion_tag[]    not null default '{}',
  density          density_type,
  color_mood       color_mood,

  -- SEMANTIC -> embedding (of description + retrieval_probes)
  description      text not null,
  retrieval_probes text[] not null default '{}',
  embedding        vector(1024),

  -- COMPOSER needs
  dom_root       text,
  entry_point    text,
  design_tokens  jsonb not null default '{}',
  content_slots  jsonb not null default '{}',
  responsive     responsive_type,
  coupling       coupling_type,

  code           text not null                  -- raw payload; Postgres TOASTs it out of line
);

create index on components using ivfflat (embedding vector_cosine_ops) with (lists = 20);
create index on components (scope, comp_type);
create index on components using gin (animation_libs);
create index on components using gin (aesthetic);
create index on components using gin (side_effects);

-- ---------- Technique index ----------
create table techniques (
  id               text primary key,            -- tech_staggered_char_reveal
  name             text not null,
  mechanism        text not null,               -- "SplitText -> chars -> gsap.from + ScrollTrigger"
  animation_libs   anim_lib[] not null default '{}',
  params           jsonb not null default '{}', -- {stagger:[0.02,0.05], y:[20,100], ease:'power3.out'}
  variations       text[] not null default '{}',
  description      text not null,
  retrieval_probes text[] not null default '{}',
  embedding        vector(1024),
  schema_version   int not null default 1
);

create index on techniques using ivfflat (embedding vector_cosine_ops) with (lists = 10);

-- seen_in: which components exhibit a technique (many-to-many).
create table component_techniques (
  component_id text references components(id) on delete cascade,
  technique_id text references techniques(id) on delete cascade,
  primary key (component_id, technique_id)
);

-- ---------- Hybrid search RPC ----------
-- WHERE cuts 400 -> a handful of valid candidates FIRST; vector ranks within that.
-- Never vector-search all 400 then filter. Null args skip their filter.
create or replace function search_components(
  query_embedding        vector(1024),
  f_scope                comp_scope      default null,
  f_comp_type            comp_type       default null,
  f_aesthetic            aesthetic_tag[] default null,
  f_exclude_side_effects side_effect[]   default null,
  f_exclude_anim_libs    anim_lib[]      default null,
  match_limit            int             default 5
)
returns table (id text, comp_type comp_type, description text, code text, sim float)
language sql stable as $$
  select c.id, c.comp_type, c.description, c.code,
         1 - (c.embedding <=> query_embedding) as sim
  from components c
  where (f_scope is null or c.scope = f_scope)
    and (f_comp_type is null or c.comp_type = f_comp_type)
    and (f_aesthetic is null or c.aesthetic && f_aesthetic)
    and (f_exclude_side_effects is null or not (c.side_effects && f_exclude_side_effects))
    and (f_exclude_anim_libs is null or not (c.animation_libs && f_exclude_anim_libs))
    and c.embedding is not null
  order by c.embedding <=> query_embedding
  limit match_limit;
$$;
