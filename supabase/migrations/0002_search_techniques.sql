-- CodeGrid RAG — technique retrieval (second pass on top of 0001).
-- 0001 created the `techniques` table and the `component_techniques` join but no
-- way to query them. This adds the retrieval side of the "invent a new site" index.
--
-- Same rule as search_components: WHERE first (stack conflicts are rejected at the
-- retriever, never patched by the composer), vector ranking within what survives.
-- vector(1024) must match the dimension used in 0001 / your embedding provider.

-- `seen_in` is what makes a technique usable: retrieve the mechanism, write fresh
-- code, then open these components for exact syntax. Returned with the hit so the
-- composer never needs a second round-trip.
create or replace function search_techniques(
  query_embedding     vector(1024),
  f_anim_libs         anim_lib[] default null,
  f_exclude_anim_libs anim_lib[] default null,
  match_limit         int        default 5
)
returns table (
  id text, name text, mechanism text, description text,
  params jsonb, variations text[], seen_in text[], sim float
)
language sql stable as $$
  select t.id, t.name, t.mechanism, t.description, t.params, t.variations,
         coalesce(array_agg(ct.component_id order by ct.component_id)
                  filter (where ct.component_id is not null), '{}') as seen_in,
         1 - (t.embedding <=> query_embedding) as sim
  from techniques t
  left join component_techniques ct on ct.technique_id = t.id
  where (f_anim_libs is null or t.animation_libs && f_anim_libs)
    and (f_exclude_anim_libs is null or not (t.animation_libs && f_exclude_anim_libs))
    and t.embedding is not null
  group by t.id, t.embedding
  order by t.embedding <=> query_embedding
  limit match_limit;
$$;

-- The PK (component_id, technique_id) only serves component-first lookups. The RPC
-- above joins technique-first (seen_in per hit), so that direction needs its own index.
create index if not exists component_techniques_technique_idx
  on component_techniques (technique_id);
