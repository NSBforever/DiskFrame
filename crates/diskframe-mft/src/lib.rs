use napi_derive::napi;
use napi::{Error, Status, Result};
use std::path::Path;
use std::fs::File;
use std::os::windows::fs::OpenOptionsExt;
use std::fs::OpenOptions;

#[napi(object)]
pub struct MftItem {
  pub path: String,
  pub name: String,
  pub ext: String,
  pub size: u64,
  pub mtime_ms: u64,
  pub is_dir: bool,
  pub parent_id: u64,
}

#[napi(object)]
pub struct ElevationStatus {
  pub is_elevated: bool,
  pub message: String,
}

#[napi]
pub fn check_elevation() -> ElevationStatus {
  #[cfg(target_os = "windows")]
  {
    use windows_sys::Win32::Security::{OpenProcessToken, TOKEN_QUERY, TOKEN_ELEVATION, TokenElevation};
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    use windows_sys::Win32::Foundation::HANDLE;
    use std::mem::MaybeUninit;

    unsafe {
      let mut token_handle: HANDLE = std::ptr::null_mut();
      if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token_handle) != 0 {
        let mut elevation: TOKEN_ELEVATION = std::mem::zeroed();
        let mut size = std::mem::size_of::<TOKEN_ELEVATION>() as u32;
        let res = windows_sys::Win32::Security::GetTokenInformation(
          token_handle,
          TokenElevation,
          &mut elevation as *mut _ as *mut _,
          size,
          &mut size,
        );
        windows_sys::Win32::Foundation::CloseHandle(token_handle);
        if res != 0 {
          let is_elevated = elevation.TokenIsElevated != 0;
          return ElevationStatus {
            is_elevated,
            message: if is_elevated {
              "Elevated (Administrator) process".to_string()
            } else {
              "Non-elevated process — opening raw volume \\\\.\\ requiring Admin rights will fail".to_string()
            },
          };
        }
      }
    }
  }

  ElevationStatus {
    is_elevated: false,
    message: "Elevation check not supported on non-Windows".to_string(),
  }
}

#[napi]
pub fn parse_ntfs_mft(volume_letter: String) -> Result<Vec<MftItem>> {
  let letter = volume_letter.trim_start_matches("\\\\.\\").trim_end_matches('\\').trim_end_matches(':');
  let volume_path = format!("\\\\.\\{}:", letter);

  // Try opening raw volume handle (requires admin elevation)
  let file_result = OpenOptions::new()
    .read(true)
    .custom_flags(0x02000000) // FILE_FLAG_BACKUP_SEMANTICS
    .open(&volume_path);

  let file = match file_result {
    Ok(f) => f,
    Err(e) => {
      return Err(Error::new(
        Status::GenericFailure,
        format!("Failed to open raw NTFS volume handle '{}': {}. Administrator elevation is required.", volume_path, e),
      ));
    }
  };

  let mut parser = match mft::MftParser::from_read_seek(file) {
    Ok(p) => p,
    Err(e) => {
      return Err(Error::new(
        Status::GenericFailure,
        format!("Failed to initialize MFT parser for '{}': {}", volume_path, e),
      ));
    }
  };

  let mut items = Vec::new();
  let count = parser.get_entry_count();

  for i in 0..count {
    if let Ok(entry) = parser.get_entry(i) {
      if entry.is_allocated() {
        let is_dir = entry.is_dir();
        let size = entry.header.record_real_size as u64;
        let name = entry.find_best_name().map(|n| n.name.clone()).unwrap_or_default();
        let ext = if !is_dir && name.contains('.') {
          name[name.rfind('.').unwrap()..].to_lowercase()
        } else {
          String::new()
        };

        items.push(MftItem {
          path: format!("{}:\\{}", letter, name),
          name,
          ext,
          size,
          mtime_ms: 0,
          is_dir,
          parent_id: entry.header.base_record_number as u64,
        });
      }
    }
  }

  Ok(items)
}

#[napi]
pub fn find_first_file_ex_walk(dir_path: String) -> Result<Vec<MftItem>> {
  let mut items = Vec::new();
  let search_pattern = format!("{}\\*", dir_path.trim_end_matches('\\'));

  #[cfg(target_os = "windows")]
  {
    use windows_sys::Win32::Storage::FileSystem::*;
    use std::os::windows::ffi::OsStrExt;
    use std::ffi::OsStr;

    let wide: Vec<u16> = OsStr::new(&search_pattern).encode_wide().chain(std::iter::once(0)).collect();
    let mut find_data: WIN32_FIND_DATAW = unsafe { std::mem::zeroed() };

    let handle = unsafe {
      FindFirstFileExW(
        wide.as_ptr(),
        FindExInfoBasic,
        &mut find_data as *mut _ as *mut _,
        FindExSearchNameMatch,
        std::ptr::null(),
        FIND_FIRST_EX_LARGE_FETCH,
      )
    };

    if handle != INVALID_HANDLE_VALUE {
      loop {
        let name_bytes: Vec<u16> = find_data.cFileName.iter().take_while(|&&c| c != 0).cloned().collect();
        let name = String::from_utf16_lossy(&name_bytes);

        if name != "." && name != ".." {
          let is_dir = (find_data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
          let size = ((find_data.nFileSizeHigh as u64) << 32) | (find_data.nFileSizeLow as u64);
          let ext = if !is_dir && name.contains('.') {
            name[name.rfind('.').unwrap()..].to_lowercase()
          } else {
            String::new()
          };

          items.push(MftItem {
            path: format!("{}\\{}", dir_path, name),
            name,
            ext,
            size,
            mtime_ms: 0,
            is_dir,
            parent_id: 0,
          });
        }

        if unsafe { FindNextFileW(handle, &mut find_data) } == 0 {
          break;
        }
      }
      unsafe { FindClose(handle); }
    }
  }

  Ok(items)
}
