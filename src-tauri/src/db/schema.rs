use rusqlite::Connection;

pub(crate) fn ensure_schema(connection: &Connection) -> Result<(), String> {
  ensure_app_schema(connection)?;
  ensure_music_schema(connection)?;
  ensure_radio_schema(connection)?;
  ensure_metadata_schema(connection)?;
  ensure_podcast_schema(connection)?;
  Ok(())
}

fn ensure_app_schema(connection: &Connection) -> Result<(), String> {
  connection
    .execute_batch(
      "
      CREATE TABLE IF NOT EXISTS app_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL,
        note TEXT
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      ",
    )
    .map_err(|error| format!("无法初始化系统表：{error}"))?;

  let has_version: i64 = connection
    .query_row(
      "SELECT COUNT(*) FROM app_schema_migrations WHERE version = 1",
      [],
      |row| row.get(0),
    )
    .map_err(|error| format!("无法读取 schema 版本：{error}"))?;
  if has_version == 0 {
    let now = super::unix_millis();
    connection
      .execute(
        "INSERT INTO app_schema_migrations (version, applied_at, note) VALUES (1, ?1, ?2)",
        rusqlite::params![now, "unified zone.sqlite bootstrap"],
      )
      .map_err(|error| format!("无法写入 schema 版本：{error}"))?;
  }
  Ok(())
}

pub(crate) fn ensure_music_schema(connection: &Connection) -> Result<(), String> {
  connection
    .execute_batch(
      "
      CREATE TABLE IF NOT EXISTS music_folders (
        path TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        last_scanned_at INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS music_tracks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        folder_path TEXT REFERENCES music_folders(path) ON DELETE SET NULL,
        file_name TEXT NOT NULL,
        extension TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        album TEXT NOT NULL,
        album_artist TEXT,
        track_number INTEGER,
        disc_number INTEGER,
        year INTEGER,
        duration_seconds REAL,
        genres_json TEXT NOT NULL DEFAULT '[]',
        cover_path TEXT,
        file_mtime_ms INTEGER,
        file_size INTEGER,
        added_at INTEGER,
        missing INTEGER NOT NULL DEFAULT 0,
        scanned_at INTEGER NOT NULL,
        raw_tags_json TEXT
      );

      CREATE INDEX IF NOT EXISTS music_tracks_album
        ON music_tracks(album_artist, album, disc_number, track_number, title);
      CREATE INDEX IF NOT EXISTS music_tracks_artist_title
        ON music_tracks(artist, title);
      CREATE INDEX IF NOT EXISTS music_tracks_added_at
        ON music_tracks(added_at DESC);
      CREATE INDEX IF NOT EXISTS music_tracks_missing
        ON music_tracks(missing, path);

      CREATE TABLE IF NOT EXISTS music_playlists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL CHECK(kind IN ('manual', 'smart')),
        is_system INTEGER NOT NULL DEFAULT 0,
        definition_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS music_playlist_items (
        playlist_id TEXT NOT NULL REFERENCES music_playlists(id) ON DELETE CASCADE,
        track_id TEXT NOT NULL REFERENCES music_tracks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY(playlist_id, track_id)
      );

      CREATE INDEX IF NOT EXISTS music_playlist_items_order
        ON music_playlist_items(playlist_id, position, added_at);

      CREATE TABLE IF NOT EXISTS music_home_pins (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('track', 'album', 'artist', 'playlist', 'podcastFeed')),
        target_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(kind, target_id)
      );

      CREATE INDEX IF NOT EXISTS music_home_pins_position
        ON music_home_pins(position, created_at);

      CREATE TABLE IF NOT EXISTS music_track_stats (
        track_id TEXT PRIMARY KEY REFERENCES music_tracks(id) ON DELETE CASCADE,
        play_count INTEGER NOT NULL DEFAULT 0,
        complete_count INTEGER NOT NULL DEFAULT 0,
        skip_count INTEGER NOT NULL DEFAULT 0,
        favorite INTEGER NOT NULL DEFAULT 0,
        first_played_at INTEGER,
        last_played_at INTEGER,
        last_completed_at INTEGER,
        last_skipped_at INTEGER,
        total_listen_ms INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS music_play_sessions (
        id TEXT PRIMARY KEY,
        track_id TEXT NOT NULL REFERENCES music_tracks(id) ON DELETE CASCADE,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        start_position_ms INTEGER NOT NULL DEFAULT 0,
        end_position_ms INTEGER,
        duration_ms INTEGER,
        listened_ms INTEGER NOT NULL DEFAULT 0,
        outcome TEXT CHECK(
          outcome IN ('playing', 'completed', 'skipped', 'replaced', 'stopped', 'error')
        ),
        source TEXT,
        session_kind TEXT NOT NULL DEFAULT 'music'
      );

      CREATE INDEX IF NOT EXISTS music_play_sessions_track_started
        ON music_play_sessions(track_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS music_play_sessions_started
        ON music_play_sessions(started_at DESC);

      CREATE TABLE IF NOT EXISTS music_playback_state (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        active_track_id TEXT REFERENCES music_tracks(id) ON DELETE SET NULL,
        position_ms INTEGER NOT NULL DEFAULT 0,
        shuffle INTEGER NOT NULL DEFAULT 0,
        repeat_mode TEXT NOT NULL DEFAULT 'off'
          CHECK(repeat_mode IN ('off', 'one', 'all')),
        volume REAL NOT NULL DEFAULT 0.8,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS music_queue_items (
        position INTEGER PRIMARY KEY,
        track_id TEXT NOT NULL REFERENCES music_tracks(id) ON DELETE CASCADE,
        added_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS music_play_history (
        position INTEGER PRIMARY KEY,
        track_id TEXT NOT NULL REFERENCES music_tracks(id) ON DELETE CASCADE,
        played_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS music_track_features (
        track_id TEXT PRIMARY KEY REFERENCES music_tracks(id) ON DELETE CASCADE,
        analyzer_version INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        duration_seconds REAL,
        sample_rate INTEGER,
        computed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS music_feature_jobs (
        track_id TEXT PRIMARY KEY REFERENCES music_tracks(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(
          status IN ('pending', 'running', 'done', 'failed', 'cancelled')
        ),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        queued_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      );
      ",
    )
    .map_err(|error| format!("无法初始化音乐表：{error}"))?;
  ensure_music_home_pins_kind_migration(connection)?;
  Ok(())
}

// SQLite cannot ALTER a CHECK constraint: rebuild music_home_pins when an
// existing database predates the podcastFeed kind.
fn ensure_music_home_pins_kind_migration(connection: &Connection) -> Result<(), String> {
  let existing_sql = connection
    .query_row(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'music_home_pins'",
      [],
      |row| row.get::<_, Option<String>>(0),
    )
    .map_err(|error| format!("无法检查 quickplay 固定项表结构：{error}"))?;
  let Some(table_sql) = existing_sql else {
    return Ok(());
  };
  if table_sql.contains("podcastFeed") {
    return Ok(());
  }
  connection
    .execute_batch(
      "
      CREATE TABLE music_home_pins_migration (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('track', 'album', 'artist', 'playlist', 'podcastFeed')),
        target_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(kind, target_id)
      );
      INSERT INTO music_home_pins_migration (id, kind, target_id, position, created_at)
        SELECT id, kind, target_id, position, created_at FROM music_home_pins;
      DROP TABLE music_home_pins;
      ALTER TABLE music_home_pins_migration RENAME TO music_home_pins;
      CREATE INDEX IF NOT EXISTS music_home_pins_position
        ON music_home_pins(position, created_at);
      ",
    )
    .map_err(|error| format!("无法迁移 quickplay 固定项表结构：{error}"))?;
  Ok(())
}

fn ensure_radio_schema(connection: &Connection) -> Result<(), String> {
  connection
    .execute_batch(
      "
      CREATE TABLE IF NOT EXISTS radio_sessions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'smartdj',
        seed_kind TEXT NOT NULL CHECK(
          seed_kind IN ('track', 'album', 'artist', 'playlist', 'mixed')
        ),
        seed_id TEXT NOT NULL,
        seed_label TEXT NOT NULL DEFAULT '',
        seed_track_ids_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK(
          status IN ('idle', 'playing', 'exhausted', 'stopped')
        ),
        constraints_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS radio_session_items (
        session_id TEXT NOT NULL REFERENCES radio_sessions(id) ON DELETE CASCADE,
        track_id TEXT NOT NULL REFERENCES music_tracks(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('played', 'queued', 'banned', 'skipped')),
        score REAL,
        reason TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(session_id, track_id, role)
      );
      ",
    )
    .map_err(|error| format!("无法初始化电台表：{error}"))?;
  ensure_database_column(
    connection,
    "radio_sessions",
    "seed_label",
    "seed_label TEXT NOT NULL DEFAULT ''",
  )?;
  ensure_database_column(
    connection,
    "radio_sessions",
    "seed_track_ids_json",
    "seed_track_ids_json TEXT NOT NULL DEFAULT '[]'",
  )?;
  Ok(())
}

pub(crate) fn ensure_metadata_schema(connection: &Connection) -> Result<(), String> {
  connection
    .execute_batch(
      "
      CREATE TABLE IF NOT EXISTS metadata_entities (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('track', 'album', 'artist')),
        display_name TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        source_path TEXT NOT NULL,
        confidence INTEGER NOT NULL CHECK(confidence BETWEEN 0 AND 100),
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metadata_entity_links (
        track_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('track', 'album', 'artist')),
        entity_id TEXT NOT NULL REFERENCES metadata_entities(id) ON DELETE CASCADE,
        linked_at INTEGER NOT NULL,
        PRIMARY KEY(track_id, kind, entity_id)
      );

      CREATE TABLE IF NOT EXISTS metadata_fields (
        entity_id TEXT NOT NULL REFERENCES metadata_entities(id) ON DELETE CASCADE,
        field_name TEXT NOT NULL,
        value_json TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        confidence INTEGER NOT NULL CHECK(confidence BETWEEN 0 AND 100),
        fetched_at INTEGER NOT NULL,
        expires_at INTEGER,
        selected INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(entity_id, field_name, provider_id)
      );

      CREATE TABLE IF NOT EXISTS metadata_provider_bindings (
        entity_id TEXT NOT NULL REFERENCES metadata_entities(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        confidence INTEGER NOT NULL CHECK(confidence BETWEEN 0 AND 100),
        matched_at INTEGER NOT NULL,
        PRIMARY KEY(entity_id, provider_id)
      );

      CREATE TABLE IF NOT EXISTS metadata_artwork_cache (
        cache_key TEXT PRIMARY KEY,
        entity_id TEXT REFERENCES metadata_entities(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        source_url TEXT NOT NULL,
        local_path TEXT NOT NULL,
        content_type TEXT,
        byte_length INTEGER,
        updated_at INTEGER NOT NULL
      );

      ",
    )
    .map_err(|error| format!("无法初始化音乐信息表：{error}"))?;
  ensure_metadata_entity_links_field_merge_migration(connection)?;
  connection
    .execute_batch(
      "
      CREATE INDEX IF NOT EXISTS metadata_entity_links_entity
        ON metadata_entity_links(entity_id);
      CREATE INDEX IF NOT EXISTS metadata_entity_links_track_kind
        ON metadata_entity_links(track_id, kind);
      CREATE INDEX IF NOT EXISTS metadata_fields_entity
        ON metadata_fields(entity_id);
      ",
    )
    .map_err(|error| format!("无法初始化音乐信息索引：{error}"))?;
  Ok(())
}

// Field-level metadata merging keeps one link per provider entity. Databases
// created by the first unified zone.sqlite release still used the older
// (track_id, kind) key, which makes the three-column UPSERT conflict target
// invalid and prevents every metadata candidate from being applied.
fn ensure_metadata_entity_links_field_merge_migration(
  connection: &Connection,
) -> Result<(), String> {
  let mut statement = connection
    .prepare("PRAGMA table_info(metadata_entity_links)")
    .map_err(|error| format!("无法检查音乐信息关联表结构：{error}"))?;
  let columns = statement
    .query_map([], |row| {
      Ok((row.get::<_, String>(1)?, row.get::<_, u32>(5)?))
    })
    .map_err(|error| format!("无法读取音乐信息关联表结构：{error}"))?;
  let mut primary_key = columns
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("无法解析音乐信息关联表结构：{error}"))?
    .into_iter()
    .filter(|(_, position)| *position > 0)
    .collect::<Vec<_>>();
  primary_key.sort_by_key(|(_, position)| *position);
  let primary_key = primary_key
    .into_iter()
    .map(|(name, _)| name)
    .collect::<Vec<_>>();
  if primary_key == ["track_id", "kind", "entity_id"] {
    return Ok(());
  }
  if primary_key != ["track_id", "kind"] {
    return Err(format!(
      "音乐信息关联表主键结构无法迁移：{}",
      primary_key.join(", ")
    ));
  }
  drop(statement);

  connection
    .execute_batch(
      "
      BEGIN IMMEDIATE;
      CREATE TABLE metadata_entity_links_field_merge (
        track_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('track', 'album', 'artist')),
        entity_id TEXT NOT NULL REFERENCES metadata_entities(id) ON DELETE CASCADE,
        linked_at INTEGER NOT NULL,
        PRIMARY KEY(track_id, kind, entity_id)
      );
      INSERT INTO metadata_entity_links_field_merge (track_id, kind, entity_id, linked_at)
        SELECT track_id, kind, entity_id, linked_at FROM metadata_entity_links;
      DROP TABLE metadata_entity_links;
      ALTER TABLE metadata_entity_links_field_merge RENAME TO metadata_entity_links;
      COMMIT;
      ",
    )
    .map_err(|error| format!("无法迁移音乐信息字段合并结构：{error}"))?;
  Ok(())
}

pub(crate) fn ensure_podcast_schema(connection: &Connection) -> Result<(), String> {
  connection
    .execute_batch(
      "
      CREATE TABLE IF NOT EXISTS podcast_feeds (
        id TEXT PRIMARY KEY,
        feed_url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        author TEXT,
        description TEXT,
        artwork_url TEXT,
        etag TEXT,
        last_modified TEXT,
        last_fetched_at INTEGER NOT NULL,
        subscribed INTEGER NOT NULL DEFAULT 1,
        subscribed_at INTEGER,
        last_checked_at INTEGER,
        last_refresh_error TEXT
      );

      CREATE TABLE IF NOT EXISTS podcast_episodes (
        id TEXT PRIMARY KEY,
        feed_id TEXT NOT NULL REFERENCES podcast_feeds(id) ON DELETE CASCADE,
        identity_key TEXT NOT NULL,
        guid TEXT,
        title TEXT NOT NULL,
        description TEXT,
        published_at INTEGER,
        duration_seconds REAL,
        enclosure_url TEXT NOT NULL,
        enclosure_type TEXT,
        artwork_url TEXT,
        expected_bytes INTEGER,
        first_seen_at INTEGER NOT NULL DEFAULT 0,
        webpage_url TEXT,
        UNIQUE(feed_id, identity_key)
      );

      CREATE TABLE IF NOT EXISTS podcast_downloads (
        episode_id TEXT PRIMARY KEY REFERENCES podcast_episodes(id) ON DELETE CASCADE,
        local_path TEXT,
        state TEXT NOT NULL CHECK(state IN ('downloading', 'downloaded', 'failed')),
        downloaded_bytes INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER,
        error_message TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS podcast_progress (
        episode_id TEXT PRIMARY KEY REFERENCES podcast_episodes(id) ON DELETE CASCADE,
        position_seconds REAL NOT NULL,
        duration_seconds REAL,
        completed INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS podcast_saved_episodes (
        episode_id TEXT PRIMARY KEY NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
        saved_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS podcast_queue (
        episode_id TEXT PRIMARY KEY NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK(position >= 0),
        added_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS podcast_episode_resources (
        id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL REFERENCES podcast_episodes(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('chapters', 'transcript')),
        source_kind TEXT NOT NULL CHECK(
          source_kind IN ('podcast-json', 'psc', 'podcast-transcript')
        ),
        url TEXT,
        mime_type TEXT,
        language TEXT,
        relation TEXT,
        ordinal INTEGER NOT NULL DEFAULT 0 CHECK(ordinal >= 0),
        etag TEXT,
        last_modified TEXT,
        fetched_at INTEGER,
        error_message TEXT
      );

      CREATE TABLE IF NOT EXISTS podcast_chapters (
        resource_id TEXT NOT NULL REFERENCES podcast_episode_resources(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        start_ms INTEGER NOT NULL CHECK(start_ms >= 0),
        end_ms INTEGER,
        title TEXT NOT NULL,
        href TEXT,
        image_url TEXT,
        visible INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(resource_id, ordinal)
      );

      CREATE INDEX IF NOT EXISTS podcast_episodes_feed_published
        ON podcast_episodes(feed_id, published_at DESC);
      CREATE INDEX IF NOT EXISTS podcast_saved_episodes_saved_at
        ON podcast_saved_episodes(saved_at DESC);
      CREATE INDEX IF NOT EXISTS podcast_queue_position
        ON podcast_queue(position, added_at, episode_id);
      CREATE INDEX IF NOT EXISTS podcast_episode_resources_episode
        ON podcast_episode_resources(episode_id, kind, ordinal);
      CREATE INDEX IF NOT EXISTS podcast_chapters_resource_start
        ON podcast_chapters(resource_id, start_ms, ordinal);
      CREATE INDEX IF NOT EXISTS podcast_feeds_subscribed_title
        ON podcast_feeds(subscribed, title COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS podcast_feeds_refresh
        ON podcast_feeds(subscribed, last_checked_at);
      CREATE INDEX IF NOT EXISTS podcast_episodes_first_seen
        ON podcast_episodes(feed_id, first_seen_at DESC);
      ",
    )
    .map_err(|error| format!("无法初始化播客表：{error}"))?;

  ensure_database_column(
    connection,
    "podcast_feeds",
    "subscribed",
    "subscribed INTEGER NOT NULL DEFAULT 1",
  )?;
  ensure_database_column(
    connection,
    "podcast_feeds",
    "subscribed_at",
    "subscribed_at INTEGER",
  )?;
  ensure_database_column(
    connection,
    "podcast_feeds",
    "last_checked_at",
    "last_checked_at INTEGER",
  )?;
  ensure_database_column(
    connection,
    "podcast_feeds",
    "last_refresh_error",
    "last_refresh_error TEXT",
  )?;
  ensure_database_column(
    connection,
    "podcast_episodes",
    "first_seen_at",
    "first_seen_at INTEGER NOT NULL DEFAULT 0",
  )?;
  ensure_database_column(
    connection,
    "podcast_episodes",
    "webpage_url",
    "webpage_url TEXT",
  )?;

  connection
    .execute_batch(
      "
      UPDATE podcast_feeds SET
        subscribed_at = CASE
          WHEN subscribed = 1 THEN COALESCE(subscribed_at, last_fetched_at)
          ELSE NULL
        END,
        last_checked_at = COALESCE(last_checked_at, last_fetched_at);

      UPDATE podcast_episodes SET
        first_seen_at = COALESCE(
          NULLIF(first_seen_at, 0),
          (SELECT last_fetched_at FROM podcast_feeds WHERE id = podcast_episodes.feed_id),
          published_at,
          0
        )
      WHERE first_seen_at = 0;
      ",
    )
    .map_err(|error| format!("无法迁移播客兼容字段：{error}"))?;
  Ok(())
}

fn ensure_database_column(
  connection: &Connection,
  table: &str,
  column: &str,
  definition: &str,
) -> Result<(), String> {
  let mut statement = connection
    .prepare(&format!("PRAGMA table_info({table})"))
    .map_err(|error| format!("无法检查数据库结构：{error}"))?;
  let columns = statement
    .query_map([], |row| row.get::<_, String>(1))
    .map_err(|error| format!("无法检查数据库结构：{error}"))?;
  for existing in columns {
    if existing.map_err(|error| format!("无法检查数据库结构：{error}"))? == column {
      return Ok(());
    }
  }
  connection
    .execute(&format!("ALTER TABLE {table} ADD COLUMN {definition}"), [])
    .map_err(|error| format!("无法迁移数据库列 {table}.{column}：{error}"))?;
  Ok(())
}
