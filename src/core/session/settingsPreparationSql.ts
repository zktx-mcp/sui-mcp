// The trigger and explicit Back use the same stored preparation transition.
// A sealed upload is separate from the short-lived confirmation of its impact.
export const SETTINGS_REUSABLE_UPLOAD_SQL = `
  kind='import_local_data' AND EXISTS (
    SELECT 1 FROM settings_files f
    WHERE f.file_id=settings_operations.file_id
      AND f.operation_id=settings_operations.operation_id AND f.role='upload'
      AND f.sealed=1 AND f.invalidated=0 AND f.received_size=f.total_size
      AND f.reservation_json IS NULL
  )`;

export const SETTINGS_RESET_PREPARATION_SQL = `
  UPDATE settings_operations SET
    phase=CASE WHEN ${SETTINGS_REUSABLE_UPLOAD_SQL} THEN 'sealed' ELSE 'draft' END,
    preparation_id=NULL,fingerprint=NULL,preparation_json=NULL,
    prepared_user_data_revision=NULL`;
