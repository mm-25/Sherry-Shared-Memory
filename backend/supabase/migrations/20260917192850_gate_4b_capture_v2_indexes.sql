create index sync_cursors_capture_adapter_idx
  on public.sync_cursors (capture_adapter_id)
  where capture_adapter_id is not null;
