{% if execute and (var('consumer_dataset_id') is none or var('consumer_valid_at') is none) %}
  {{ exceptions.raise_compiler_error('Set consumer_dataset_id and consumer_valid_at explicitly; Consumer views are one declared investigation scope.') }}
{% endif %}
{% set sequence = var('consumer_known_sequence') %}
{% if sequence is not none and (sequence|string != sequence|int|string or sequence|int < 1) %}
  {{ exceptions.raise_compiler_error('consumer_known_sequence must be a positive integer') }}
{% endif %}
select dataset_id,
  {% if var('consumer_known_sequence') is none %}max(knowledge_from_sequence){% else %}{{ var('consumer_known_sequence') | int }}{% endif %} as known_sequence,
  cast('{{ (var("consumer_valid_at") or "").replace("'", "''") }}' as timestamp) as physical_at
from {{ ref('dim_source_revision') }}
where dataset_id = '{{ (var("consumer_dataset_id") or "").replace("'", "''") }}'
group by dataset_id
