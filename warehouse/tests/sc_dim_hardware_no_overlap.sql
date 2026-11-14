select a.hardware_version_key from {{ ref('sc_dim_hardware') }} a
join {{ ref('sc_dim_hardware') }} b on a.hardware_key = b.hardware_key and a.hardware_version_key < b.hardware_version_key
where a.hardware_version_key <> '__unknown__'
  and (b.knowledge_to_sequence is null or a.knowledge_from_sequence < b.knowledge_to_sequence)
  and (a.knowledge_to_sequence is null or b.knowledge_from_sequence < a.knowledge_to_sequence)
