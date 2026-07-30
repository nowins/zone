use crate::podcast::{is_public_ip, read_limited, send_public_get_with_headers};
use reqwest::header::{self, HeaderMap, HeaderValue};
use reqwest::{StatusCode, Url};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const METADATA_ARTWORK_RESPONSE_LIMIT: usize = 8 * 1024 * 1024;
const METADATA_DNS_RESPONSE_LIMIT: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
struct DnsJsonResponse {
  Status: i32,
  #[serde(default)]
  Answer: Vec<DnsJsonAnswer>,
}

#[derive(Debug, Deserialize)]
struct DnsJsonAnswer {
  #[serde(rename = "type")]
  record_type: u16,
  data: String,
}

pub(crate) async fn cache_provider_artwork(
  cache_dir: &Path,
  value: &str,
  label: &str,
  allowed_host: fn(&str) -> bool,
) -> Result<PathBuf, String> {
  let url = Url::parse(value).map_err(|_| format!("{label}地址无效"))?;
  if url.scheme() != "https" || !url.host_str().is_some_and(allowed_host) {
    return Err(format!("{label}地址不受支持"));
  }
  let cache_key = sha256_hex(url.as_str().as_bytes());
  for extension in ["jpg", "png", "webp"] {
    let path = cache_dir.join(format!("{cache_key}.{extension}"));
    if path.is_file() {
      return Ok(path);
    }
  }

  let host = url
    .host_str()
    .ok_or_else(|| format!("{label}地址缺少主机名"))?
    .to_string();
  let request_headers = artwork_request_headers(&host);
  let public_response = match send_public_get_with_headers(
    url.clone(),
    Duration::from_secs(15),
    None,
    false,
    &request_headers,
  )
  .await
  {
    Ok(response) => response,
    Err(initial_error) if is_netease_cdn_host(&host) => {
      let addresses = resolve_metadata_artwork_addresses(&host).await.map_err(|fallback| {
        format!(
          "{}；备用解析失败：{fallback}",
          metadata_network_error(initial_error, label)
        )
      })?;
      send_artwork_with_addresses(url.clone(), &host, &addresses, &request_headers)
        .await
        .map_err(|fallback| format!("{label}下载失败：{fallback}"))?
    }
    Err(error) => return Err(metadata_network_error(error, label)),
  };
  if public_response.final_url.scheme() != "https"
    || !public_response
      .final_url
      .host_str()
      .is_some_and(allowed_host)
  {
    return Err(format!("{label}重定向地址不受支持"));
  }
  let bytes = match read_limited(
    public_response.response,
    METADATA_ARTWORK_RESPONSE_LIMIT,
    label,
  )
  .await
  {
    Ok(bytes) => bytes,
    Err(initial_error) if is_netease_cdn_host(&host) => {
      let addresses = resolve_metadata_artwork_addresses(&host).await.map_err(|fallback| {
        format!("{initial_error}；备用解析失败：{fallback}")
      })?;
      let fallback =
        send_artwork_with_addresses(url.clone(), &host, &addresses, &request_headers)
          .await
          .map_err(|error| format!("{initial_error}；备用下载失败：{error}"))?;
      read_limited(
        fallback.response,
        METADATA_ARTWORK_RESPONSE_LIMIT,
        label,
      )
      .await
      .map_err(|error| format!("{initial_error}；备用下载读取失败：{error}"))?
    }
    Err(error) => return Err(error),
  };
  let extension =
    image_extension(&bytes).ok_or_else(|| format!("{label}格式不受支持"))?;
  let final_path = cache_dir.join(format!("{cache_key}.{extension}"));
  let nonce = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .ok()
    .map(|duration| duration.as_nanos())
    .unwrap_or(0);
  let temporary_path = cache_dir.join(format!(
    "{cache_key}.{}-{nonce}.part",
    std::process::id()
  ));
  tokio::fs::write(&temporary_path, &bytes)
    .await
    .map_err(|error| format!("无法缓存{label}：{error}"))?;
  if let Err(error) = tokio::fs::rename(&temporary_path, &final_path).await {
    if !final_path.is_file() {
      let _ = tokio::fs::remove_file(&temporary_path).await;
      return Err(format!("无法保存{label}：{error}"));
    }
    let _ = tokio::fs::remove_file(&temporary_path).await;
  }
  Ok(final_path)
}

fn artwork_request_headers(host: &str) -> HeaderMap {
  let mut headers = HeaderMap::new();
  headers.insert(header::ACCEPT, HeaderValue::from_static("image/avif,image/webp,image/png,image/jpeg,*/*"));
  headers.insert(header::ACCEPT_ENCODING, HeaderValue::from_static("identity"));
  if is_netease_cdn_host(host) {
    headers.insert(
      header::REFERER,
      HeaderValue::from_static("https://music.163.com/"),
    );
  }
  headers
}

fn metadata_network_error(error: String, label: &str) -> String {
  error
    .replace("播客来源", label)
    .replace("播客请求", label)
}

fn is_netease_cdn_host(host: &str) -> bool {
  let host = host.to_ascii_lowercase();
  host == "music.126.net" || host.ends_with(".music.126.net")
}

async fn resolve_metadata_artwork_addresses(host: &str) -> Result<Vec<IpAddr>, String> {
  if !is_netease_cdn_host(host) {
    return Err("图片主机不支持备用解析".to_string());
  }
  let mut addresses = Vec::new();
  let mut last_error = String::new();
  for (base, expected_host, expected_path) in [
    (
      "https://dns.alidns.com/resolve",
      "dns.alidns.com",
      "/resolve",
    ),
    (
      "https://cloudflare-dns.com/dns-query",
      "cloudflare-dns.com",
      "/dns-query",
    ),
  ] {
    match request_dns_json(base, expected_host, expected_path, host).await {
      Ok(response) => {
        for answer in response.Answer {
          let Some(address) = answer.data.parse::<IpAddr>().ok() else {
            continue;
          };
          if matches!(answer.record_type, 1 | 28)
            && is_public_ip(address)
            && !addresses.contains(&address)
          {
            addresses.push(address);
          }
          if addresses.len() >= 12 {
            break;
          }
        }
      }
      Err(error) => last_error = error,
    }
  }
  if addresses.is_empty() {
    return Err(if last_error.is_empty() {
      "备用解析没有返回公网地址".to_string()
    } else {
      last_error
    });
  }
  Ok(addresses)
}

async fn request_dns_json(
  base: &str,
  expected_host: &str,
  expected_path: &str,
  query_host: &str,
) -> Result<DnsJsonResponse, String> {
  let mut url =
    Url::parse(base).map_err(|_| "无法构造备用解析地址".to_string())?;
  url
    .query_pairs_mut()
    .append_pair("name", query_host)
    .append_pair("type", "A");
  let mut headers = HeaderMap::new();
  headers.insert(
    header::ACCEPT,
    HeaderValue::from_static("application/dns-json"),
  );
  let public_response = send_public_get_with_headers(
    url,
    Duration::from_secs(6),
    None,
    false,
    &headers,
  )
  .await
  .map_err(|error| metadata_network_error(error, "备用 DNS"))?;
  if public_response.final_url.scheme() != "https"
    || !public_response
      .final_url
      .host_str()
      .is_some_and(|value| value.eq_ignore_ascii_case(expected_host))
    || public_response.final_url.path() != expected_path
  {
    return Err("备用解析返回了不受支持的地址".to_string());
  }
  let bytes = read_limited(
    public_response.response,
    METADATA_DNS_RESPONSE_LIMIT,
    "备用 DNS 响应",
  )
  .await?;
  let response = serde_json::from_slice::<DnsJsonResponse>(&bytes)
    .map_err(|_| "备用解析结果格式无效".to_string())?;
  if response.Status != 0 {
    return Err(format!("备用解析返回错误 {}", response.Status));
  }
  Ok(response)
}

async fn send_artwork_with_addresses(
  url: Url,
  host: &str,
  addresses: &[IpAddr],
  headers: &HeaderMap,
) -> Result<crate::podcast::PublicResponse, String> {
  tokio::time::timeout(
    Duration::from_secs(20),
    send_artwork_with_addresses_inner(url, host, addresses, headers),
  )
  .await
  .map_err(|_| "图片来源响应超时".to_string())?
}

async fn send_artwork_with_addresses_inner(
  url: Url,
  host: &str,
  addresses: &[IpAddr],
  headers: &HeaderMap,
) -> Result<crate::podcast::PublicResponse, String> {
  let mut last_error = "图片来源没有可用地址".to_string();
  for address in addresses.iter().take(12) {
    let socket_addresses = [SocketAddr::new(*address, 443)];
    let client = reqwest::Client::builder()
      .user_agent(concat!("Zone/", env!("CARGO_PKG_VERSION")))
      .connect_timeout(Duration::from_secs(5))
      .timeout(Duration::from_secs(10))
      .redirect(reqwest::redirect::Policy::none())
      .no_proxy()
      .no_gzip()
      .no_brotli()
      .no_deflate()
      .no_zstd()
      .resolve_to_addrs(host, &socket_addresses)
      .build()
      .map_err(|error| format!("无法初始化图片请求：{error}"))?;
    let response = match client
      .get(url.clone())
      .headers(headers.clone())
      .send()
      .await
    {
      Ok(response) => response,
      Err(error) => {
        last_error = format!("无法连接图片来源：{error}");
        continue;
      }
    };
    if response.status().is_redirection() {
      last_error = "图片来源返回了未允许的重定向".to_string();
      continue;
    }
    if response.status() != StatusCode::OK {
      last_error = format!("图片来源返回错误 {}", response.status().as_u16());
      continue;
    }
    return Ok(crate::podcast::PublicResponse {
      final_url: url,
      response,
    });
  }
  Err(last_error)
}

pub(crate) fn image_extension(bytes: &[u8]) -> Option<&'static str> {
  if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
    Some("jpg")
  } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
    Some("png")
  } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
    Some("webp")
  } else {
    None
  }
}

fn sha256_hex(value: &[u8]) -> String {
  let digest = Sha256::digest(value);
  let mut output = String::with_capacity(64);
  for byte in digest {
    output.push_str(&format!("{byte:02x}"));
  }
  output
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn dns_json_keeps_only_public_address_answers() {
    let response: DnsJsonResponse = serde_json::from_str(
      r#"{"Status":0,"Answer":[
        {"name":"p1.music.126.net.","type":5,"TTL":60,"data":"cdn.example."},
        {"name":"cdn.example.","type":1,"TTL":60,"data":"119.36.153.41"},
        {"name":"cdn.example.","type":1,"TTL":60,"data":"127.0.0.1"}
      ]}"#,
    )
    .unwrap();
    let addresses = response
      .Answer
      .into_iter()
      .filter(|answer| answer.record_type == 1)
      .filter_map(|answer| answer.data.parse::<IpAddr>().ok())
      .filter(|address| is_public_ip(*address))
      .collect::<Vec<_>>();
    assert_eq!(
      addresses,
      vec!["119.36.153.41".parse::<IpAddr>().unwrap()]
    );
  }
}
