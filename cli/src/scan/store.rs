use super::{
    http::Api,
    snapshot,
    support::{hash, now, read, string, valid_id, write, write_json},
};
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

const README: &str = "# .intent\n\nProject knowledge and evidence from explicitly requested Scans and proofs.\nCommit this folder with the source; do not blanket-ignore it.\n\n- prove/<target>/: proof inputs, scope and PROOF.md; prove/sessions/ is local CLI state.\n- scan/<task-id>/: collected report.json and meta.json with source hashes and collection status.\n- NOTES.md: confirmed intended behaviour, included in later scans.\n\nScan commands wait for completion and save results. Use collect to resume an interrupted\nScan without resubmitting source. No automatic hooks or reviews run. Supporting Scan files remain remote.\n\nTransient .queue, .sent.log and .storage.lock files are not committed.\nThe sent log records upload metadata, never source contents. Old queues are not consumed.\n";

pub(super) fn prepare(root: &Path, id: Option<&str>) -> Result<PathBuf> {
    ensure!(
        root.is_dir() && id.is_none_or(valid_id),
        "Invalid Scan destination"
    );
    let base = root.join(".intent");
    ensure!(
        !fs::symlink_metadata(&base).is_ok_and(|m| m.is_symlink()),
        ".intent is a symlink"
    );
    fs::create_dir_all(&base)?;
    for (name, content) in [
        ("README.md", README),
        (".ignore", "*\n"),
        (".gitignore", ".sent.log\n.queue\n.storage.lock\n"),
    ] {
        let file = base.join(name);
        if !file.exists() {
            write(&file, content.as_bytes(), false)?;
        }
    }
    let dir = match id {
        Some(id) => base.join("scan").join(id),
        None => base.join("scan"),
    };
    let mut ancestor = dir.as_path();
    while !ancestor.exists() {
        ancestor = ancestor
            .parent()
            .expect("Scan directory has repository ancestor");
    }
    ensure!(
        snapshot::canonical(ancestor)?.starts_with(snapshot::canonical(&base)?),
        "Scan destination is outside .intent"
    );
    fs::create_dir_all(&dir)?;
    // Check actual writability before submitting source, even when the directory exists.
    let probe = dir.join(format!(".scan-{}.tmp", uuid::Uuid::new_v4()));
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)?;
    fs::remove_file(probe)?;
    Ok(dir)
}

pub(super) fn metadata(scan: &Value, task: Option<&Value>, api: &Api) -> Result<(PathBuf, Value)> {
    let dir = prepare(
        Path::new(string(&scan["repo_root"])),
        Some(string(&scan["job_id"])),
    )?;
    let previous = read(&dir.join("meta.json"));
    let task = task.map(|task| {
        let reference = &task["result"]["report"];
        let report = if reference.is_null() { Value::Null } else {
            json!({"name":reference["name"],"url":reference["url"],"size":reference["size"],"sha256":reference["sha256"]})
        };
        let error = if task["error"].is_null() { Value::Null } else {
            json!({"code":task["error"]["code"],"message":task["error"]["message"]})
        };
        json!({
            "id":task["id"], "kind":task["kind"], "status":task["status"],
            "created_at":task["createdAt"], "started_at":task["startedAt"],
            "finished_at":task["finishedAt"], "files_expire_at":task["filesExpireAt"],
            "budget_s":task["result"]["budgetSeconds"], "report":report, "error":error,
        })
    }).unwrap_or_else(|| previous["task"].clone());
    let mut meta = json!({
        "version":1, "task_id":scan["job_id"], "url":scan["url"],
        "api_url":scan["api_url"].as_str().unwrap_or(&api.config.server_url),
        "created_at":scan["created_at"], "updated_at":now(), "depth":scan["depth"],
        "scope":scan["scope"], "source":scan.get("source").unwrap_or(&previous["source"]),
        "task":task, "status":scan["status"],
        "report":previous.get("report").cloned().unwrap_or_else(|| json!({"status":"pending"})),
    });
    if meta["report"]["status"] != "saved" {
        if ["failed", "superseded"].contains(&string(&scan["status"])) {
            meta["report"] = json!({"status":"unavailable","reason":scan["error"]["code"].as_str().unwrap_or(string(&scan["status"]))});
        }
        if ["expired", "unavailable"].contains(&string(&scan["report_status"])) {
            meta["report"] = json!({"status":scan["report_status"],"reason":scan["report_error"].as_str().or(scan["error"]["code"].as_str()).unwrap_or(string(&scan["status"]))});
        }
    }
    write_json(&dir.join("meta.json"), &meta, false)?;
    Ok((dir, meta))
}

pub(super) fn report(scan: &Value, task: &Value, api: &Api) -> Result<Value> {
    let (dir, mut meta) = metadata(scan, Some(task), api)?;
    let reference = &task["result"]["report"];
    let saved = fs::read(dir.join("report.json")).ok();
    if saved.as_ref().is_some_and(|bytes| {
        Some(bytes.len() as u64) == reference["size"].as_u64() && hash(bytes) == reference["sha256"]
    }) {
        meta["report"] = json!({"status":"saved","size":reference["size"],"sha256":reference["sha256"],"saved_at":meta["report"]["saved_at"].as_str().map(str::to_owned).unwrap_or_else(now)});
    } else {
        let result = api.report(task);
        if result.status == 200 {
            write(&dir.join("report.json"), &result.bytes, false)?;
            meta["report"] = json!({"status":"saved","size":reference["size"],"sha256":reference["sha256"],"saved_at":now()});
        } else {
            let status = if result.status == 410 {
                "expired"
            } else if [400, 404].contains(&result.status) {
                "unavailable"
            } else {
                "pending"
            };
            meta["report"] = json!({"status":status,"reason":result.code()});
        }
    }
    write_json(&dir.join("meta.json"), &meta, false)?;
    Ok(meta["report"].clone())
}

pub(super) fn sent_log(root: &Path, entry: Value) {
    let _ = (|| -> Result<()> {
        let file = root.join(".intent/.sent.log");
        if let Ok(st) = fs::symlink_metadata(&file) {
            ensure!(
                st.is_file() && !st.is_symlink(),
                "Expected regular upload log"
            );
        }
        let mut options = fs::OpenOptions::new();
        options.append(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o644).custom_flags(libc::O_NOFOLLOW);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(0x00200000);
        }
        let mut output = options.open(&file)?;
        let st = output.metadata()?;
        ensure!(st.is_file(), "Expected regular upload log");
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            ensure!(st.nlink() == 1, "Upload log must not be hard-linked");
        }
        #[cfg(windows)]
        {
            ensure!(
                windows_link_count(&output)? == 1,
                "Upload log must not be hard-linked"
            );
        }
        writeln!(output, "{entry}")?;
        Ok(())
    })();
}

#[cfg(windows)]
fn windows_link_count(file: &fs::File) -> std::io::Result<u32> {
    use std::{ffi::c_void, mem::MaybeUninit, os::windows::io::AsRawHandle};
    #[repr(C)]
    struct StandardInfo {
        allocation_size: i64,
        end_of_file: i64,
        number_of_links: u32,
        delete_pending: u8,
        directory: u8,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandleEx(
            handle: *mut c_void,
            class: i32,
            info: *mut c_void,
            size: u32,
        ) -> i32;
    }
    let mut info = MaybeUninit::<StandardInfo>::uninit();
    // SAFETY: the file owns a live handle. FileStandardInfo (1) writes this C layout;
    // the buffer is read only after the API reports a successful, bounded write.
    unsafe {
        if GetFileInformationByHandleEx(
            file.as_raw_handle(),
            1,
            info.as_mut_ptr().cast(),
            std::mem::size_of::<StandardInfo>() as u32,
        ) == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(info.assume_init().number_of_links)
    }
}
