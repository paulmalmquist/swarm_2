select * from {{ ref('stg_manufacturing_deliveries') }}
qualify row_number() over (partition by source_revision_key order by ingestion_sequence) = 1
