-- cursor-sidecar.lua — OBS script: record cursor telemetry alongside every recording.
--
-- On "recording started" it launches the cursor-sidecar binary writing into the
-- recording folder; on "recording stopped" it stops the logger and renames the
-- log to match the recording file: `2026-06-11 20-33-12.mkv` gets
-- `2026-06-11 20-33-12.cursor.ndjson` sitting right next to it. Attach (or
-- drag-drop) that file in the creatorgrowth editor and Auto Magic zooms on the
-- exact spots the mouse worked.
--
-- Install once: OBS → Tools → Scripts → "+" → pick this file. Set the binary
-- path in the script settings if it isn't at the default.
--
-- macOS note: the sidecar needs Accessibility trust for click/element data.
-- When OBS launches it, macOS attributes the permission to OBS — grant OBS in
-- System Settings → Privacy & Security → Accessibility. Without it, positions
-- still log (that's what the zoom targeting needs); only click/hover
-- classification degrades.

local obs = obslua

local SIDECAR_DEFAULT = os.getenv("HOME") .. "/dev/cursor-sidecar/cursor-sidecar"
local PID_FILE = "/tmp/obs-cursor-sidecar.pid"

local sidecar_path = SIDECAR_DEFAULT
local staged_log = nil

local function shell(cmd)
	os.execute("/bin/sh -c " .. string.format("%q", cmd))
end

local function record_folder()
	local path = obs.obs_frontend_get_current_record_output_path()
	if path and path ~= "" then
		return path
	end
	return os.getenv("HOME") .. "/Movies"
end

local function file_exists(path)
	local f = io.open(path, "r")
	if f then
		f:close()
		return true
	end
	return false
end

local function start_logger()
	if not file_exists(sidecar_path) then
		obs.script_log(obs.LOG_WARNING,
			"cursor-sidecar binary not found at " .. sidecar_path .. " — no cursor log for this recording")
		return
	end
	staged_log = record_folder() .. "/cursor_" .. os.time() .. ".ndjson.recording"
	-- nohup + & so OBS's UI thread never blocks; pidfile for the stop side.
	shell('nohup "' .. sidecar_path .. '" --out "' .. staged_log ..
		'" >/dev/null 2>&1 & echo $! > ' .. PID_FILE)
	obs.script_log(obs.LOG_INFO, "cursor-sidecar started → " .. staged_log)
end

local function stop_logger()
	if not staged_log then
		return
	end
	local final = nil
	local recording = obs.obs_frontend_get_last_recording()
	if recording and recording ~= "" then
		final = recording:gsub("%.[^./]+$", "") .. ".cursor.ndjson"
	else
		final = staged_log:gsub("%.recording$", "")
	end
	-- SIGINT lets the sidecar close the file cleanly; the rename runs in a
	-- detached subshell after a settle pause so OBS never waits on it.
	shell('( kill -INT "$(cat ' .. PID_FILE .. ' 2>/dev/null)" 2>/dev/null; sleep 0.6; mv "' ..
		staged_log .. '" "' .. final .. '" 2>/dev/null; rm -f ' .. PID_FILE .. ' ) >/dev/null 2>&1 &')
	obs.script_log(obs.LOG_INFO, "cursor-sidecar stopped → " .. final)
	staged_log = nil
end

local function on_event(event)
	if event == obs.OBS_FRONTEND_EVENT_RECORDING_STARTED then
		start_logger()
	elseif event == obs.OBS_FRONTEND_EVENT_RECORDING_STOPPED then
		stop_logger()
	end
end

function script_description()
	return "Runs the cursor-sidecar telemetry logger with every recording and drops a " ..
		"matching .cursor.ndjson next to the recording file. For creatorgrowth Auto Magic v4."
end

function script_properties()
	local props = obs.obs_properties_create()
	obs.obs_properties_add_path(props, "sidecar_path", "cursor-sidecar binary",
		obs.OBS_PATH_FILE, "", SIDECAR_DEFAULT)
	return props
end

function script_update(settings)
	local p = obs.obs_data_get_string(settings, "sidecar_path")
	if p and p ~= "" then
		sidecar_path = p
	end
end

function script_defaults(settings)
	obs.obs_data_set_default_string(settings, "sidecar_path", SIDECAR_DEFAULT)
end

function script_load(_settings)
	obs.obs_frontend_add_event_callback(on_event)
end

function script_unload()
	-- OBS quitting mid-record: don't orphan the logger.
	shell('kill -INT "$(cat ' .. PID_FILE .. ' 2>/dev/null)" 2>/dev/null; rm -f ' .. PID_FILE)
end
