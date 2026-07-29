use super::{APP_USER_MODEL_ID, PKEY_APP_USER_MODEL_ID};
use std::mem::{size_of, ManuallyDrop};
use windows::core::{w, HSTRING, Interface, Result as WindowsResult};
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Com::StructuredStorage::{
    PropVariantClear, PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, REG_SZ,
};
use windows::Win32::System::Variant::VT_LPWSTR;
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::Shell::{
    IShellLinkW, SHChangeNotify, SHStrDupW, ShellLink, SHCNE_ASSOCCHANGED, SHCNF_IDLIST,
};

pub(super) fn register_app_identity() -> Result<(), String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("Unable to locate the Zone executable: {error}"))?;
    let mut identities = vec![APP_USER_MODEL_ID.to_string()];
    if let Some(file_name) = executable.file_name().and_then(|name| name.to_str()) {
        if !file_name.eq_ignore_ascii_case(APP_USER_MODEL_ID) {
            identities.push(file_name.to_string());
        }
    }

    for identity in identities {
        register_app_identity_key(&identity, Some(&executable))?;
    }
    register_start_menu_shortcut(&executable)?;
    unsafe {
        SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
    }
    Ok(())
}

fn register_start_menu_shortcut(executable: &std::path::Path) -> Result<(), String> {
    let app_data = std::env::var_os("APPDATA")
        .ok_or("Unable to locate the Windows application data directory")?;
    let shortcut_directory = std::path::PathBuf::from(app_data)
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs");
    std::fs::create_dir_all(&shortcut_directory).map_err(|error| {
        format!("Unable to prepare the Windows Start menu directory: {error}")
    })?;
    let shortcut_path = shortcut_directory.join("Zone.lnk");
    let executable = HSTRING::from(executable.to_string_lossy().as_ref());
    let shortcut_path = HSTRING::from(shortcut_path.to_string_lossy().as_ref());

    let com_status = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    com_status
        .ok()
        .map_err(|error| format!("Unable to initialize Windows Shell integration: {error}"))?;

    let result: WindowsResult<()> = (|| {
        let shell_link: IShellLinkW =
            unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)? };
        unsafe {
            shell_link.SetPath(&executable)?;
            shell_link.SetDescription(w!("Zone music player"))?;
            shell_link.SetIconLocation(&executable, 0)?;
        }

        let property_store: IPropertyStore = shell_link.cast()?;
        let app_id = HSTRING::from(APP_USER_MODEL_ID);
        let app_id_buffer = unsafe { SHStrDupW(&app_id)? };
        let mut app_id_value = PROPVARIANT {
            Anonymous: PROPVARIANT_0 {
                Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                    vt: VT_LPWSTR,
                    wReserved1: 0,
                    wReserved2: 0,
                    wReserved3: 0,
                    Anonymous: PROPVARIANT_0_0_0 {
                        pwszVal: app_id_buffer,
                    },
                }),
            },
        };
        let set_value_result =
            unsafe { property_store.SetValue(&PKEY_APP_USER_MODEL_ID, &app_id_value) };
        let clear_result = unsafe { PropVariantClear(&mut app_id_value) };
        set_value_result?;
        clear_result?;
        unsafe { property_store.Commit()? };

        let persist_file: IPersistFile = shell_link.cast()?;
        unsafe { persist_file.Save(&shortcut_path, true)? };
        Ok(())
    })();

    unsafe {
        CoUninitialize();
    }
    result.map_err(|error| format!("Unable to register the Zone Start menu shortcut: {error}"))
}

fn register_app_identity_key(
    identity: &str,
    executable: Option<&std::path::Path>,
) -> Result<(), String> {
    let registry_path = HSTRING::from(format!("Software\\Classes\\AppUserModelId\\{identity}"));
    let mut key = HKEY::default();
    let status = unsafe { RegCreateKeyW(HKEY_CURRENT_USER, &registry_path, &mut key) };
    if status != ERROR_SUCCESS {
        return Err(format!(
            "Unable to register the Zone application identity: {status:?}"
        ));
    }

    let result: Result<(), String> = (|| {
        set_registry_string(key, w!("DisplayName"), "Zone")?;
        if let Some(executable) = executable {
            set_registry_string(key, w!("IconUri"), &executable.to_string_lossy())?;
        }
        Ok(())
    })();
    unsafe {
        let _ = RegCloseKey(key);
    }
    result?;
    Ok(())
}

fn set_registry_string(
    key: HKEY,
    name: windows::core::PCWSTR,
    value: &str,
) -> Result<(), String> {
    let wide = value
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let bytes = unsafe {
        std::slice::from_raw_parts(wide.as_ptr() as *const u8, wide.len() * size_of::<u16>())
    };
    let status = unsafe { RegSetValueExW(key, name, None, REG_SZ, Some(bytes)) };
    if status == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(format!(
            "Unable to write the Zone application identity: {status:?}"
        ))
    }
}
