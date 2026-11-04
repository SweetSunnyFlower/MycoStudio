pub mod commands;
pub mod domain;
pub mod driver;
pub mod error;
pub mod service;
pub mod storage;
pub mod ssh_tunnel;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::list_connections,
            commands::save_connection,
            commands::delete_connection,
            commands::test_connection,
            commands::test_saved_connection,
            commands::connect,
            commands::disconnect,
            commands::list_databases,
            commands::redis_scan,
            commands::redis_entry,
            commands::redis_set_string,
            commands::redis_delete,
            commands::redis_expire,
            commands::redis_exec,
            commands::redis_select_db,
            commands::mongodb_list_collections,
            commands::mongodb_find,
            commands::mongodb_insert_one,
            commands::mongodb_replace_one,
            commands::mongodb_delete_one,
            commands::es_cluster_info,
            commands::es_indices,
            commands::es_fields,
            commands::es_search,
            commands::es_index_doc,
            commands::es_create_index,
            commands::es_delete_index,
            commands::es_delete_doc,
            commands::es_request,
            commands::list_tables,
            commands::list_columns,
            commands::database_schema,
            commands::table_ddl,
            commands::schema_graph,
            commands::read_pdm,
            commands::list_pdm_files,
            commands::list_pdm_notes,
            commands::save_pdm_note,
            commands::delete_pdm_note,
            commands::get_app_setting,
            commands::set_app_setting,
            commands::apply_changes,
            commands::preview_changes,
            commands::run_sql,
            commands::explain_plan,
            commands::browse_table,
            commands::export_table,
            commands::create_database,
            commands::import_csv_preview,
            commands::import_csv,
            commands::run_sql_file,
            commands::write_text_file,
            commands::write_bytes_file,
            commands::foreign_keys,
            commands::app_info,
            commands::table_comment,
            commands::indexes,
            commands::list_ai_providers,
            commands::save_ai_provider,
            commands::delete_ai_provider,
            commands::set_default_ai_provider,
            commands::sync_ai_models,
            commands::ai_analyze_plan_stream,
            commands::ai_cancel,
            commands::test_ai_provider,
            commands::list_ai_conversations,
            commands::create_ai_conversation,
            commands::delete_ai_conversation,
            commands::ai_conversation_messages,
            commands::ai_chat_send,
            commands::ai_chat_cancel,
            commands::list_sql_history,
            commands::push_sql_history,
            commands::list_saved_sql,
            commands::save_sql,
            commands::delete_saved_sql,
        ])
        .setup(|app| {
            let dir = crate::storage::config_dir();
            app.manage(commands::build_state(dir));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
