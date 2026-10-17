CREATE INDEX items_mcp_recent ON items (
  coalesce(json_extract(metadata_json,'$.likedAt'),json_extract(metadata_json,'$.fetchedAt')) DESC,
  id DESC
) WHERE json_extract(metadata_json,'$.origin')='x';
