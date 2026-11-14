select source_revision_key from {{ ref('stg_manufacturing_deliveries') }}
where dataset_id is null or dataset_id = '' or source_system is null or source_type is null or source_native_id is null
  or source_revision is null or source_revision <= 0 or ingestion_sequence is null or ingestion_sequence <= 0
  or known_from is null or valid_from is null or (valid_to is not null and valid_to <= valid_from)
  or record_hash is null or length(record_hash) <> 64
  or record_hash <> {{ text_sha('record_json') }}
  or is_withdrawn is null or data_class is null or data_class not in ('synthetic','real')
  or record_kind is null or record_kind not in ('hardware','relationship','configuration','finding','evidence')
  or access_tags_json is null or access_tags_json in ('[]','null')
  or (not is_withdrawn and (payload_json is null or payload_json = 'null'))
  or (is_withdrawn and payload_json is not null and payload_json <> 'null')
