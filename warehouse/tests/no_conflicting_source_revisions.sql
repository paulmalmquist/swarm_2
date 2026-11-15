select source_revision_key
from {{ ref('stg_manufacturing_deliveries') }}
group by source_revision_key
having count(distinct record_hash) <> 1 or count(distinct record_json) <> 1
