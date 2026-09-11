CREATE TABLE scene_room_keys (
 scene_id uuid PRIMARY KEY REFERENCES scenes(id) ON DELETE CASCADE,
 room_id text NOT NULL, encrypted_key text NOT NULL
);
GRANT ALL ON scene_room_keys TO excalidraw;
