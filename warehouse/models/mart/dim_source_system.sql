select distinct source_system_key, dataset_id, source_system from {{ ref('stg_manufacturing_versions') }}
union all select '__unknown__', '__unknown__', 'Unknown'
