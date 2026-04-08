use serde::{Deserialize, Serialize};
use std::fs;
use std::sync::Mutex;
use once_cell::sync::Lazy;

/// Usage data returned to the frontend
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageResponse {
    pub five_hour: Option<UsageWindow>,
    pub seven_day: Option<UsageWindow>,
    pub seven_day_opus: Option<UsageWindow>,
    pub seven_day_sonnet: Option<UsageWindow>,
    pub extra_usage: Option<ExtraUsage>,
    pub fetched_at: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub utilization: f64,
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtraUsage {
    pub is_enabled: bool,
    pub monthly_limit: f64,
    pub used_credits: f64,
}

/// Raw API response from Anthropic
#[derive(Debug, Deserialize)]
struct ApiResponse {
    five_hour: Option<ApiWindow>,
    seven_day: Option<ApiWindow>,
    seven_day_opus: Option<ApiWindow>,
    seven_day_sonnet: Option<ApiWindow>,
    extra_usage: Option<ApiExtraUsage>,
}

#[derive(Debug, Deserialize)]
struct ApiWindow {
    utilization: Option<f64>,
    resets_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiExtraUsage {
    is_enabled: Option<bool>,
    monthly_limit: Option<f64>,
    used_credits: Option<f64>,
}

/// Credentials file structure
#[derive(Debug, Deserialize)]
struct CredentialsFile {
    #[serde(rename = "claudeAiOauth")]
    claude_ai_oauth: Option<OAuthCredentials>,
}

#[derive(Debug, Deserialize)]
struct OAuthCredentials {
    #[serde(rename = "accessToken")]
    access_token: Option<String>,
}

// Cache the last successful response
static USAGE_CACHE: Lazy<Mutex<Option<UsageResponse>>> = Lazy::new(|| Mutex::new(None));

/// Read the OAuth access token from ~/.claude/.credentials.json
fn read_oauth_token() -> Result<String, String> {
    let creds_path = dirs::home_dir()
        .ok_or("Cannot determine home directory")?
        .join(".claude")
        .join(".credentials.json");

    let content = fs::read_to_string(&creds_path)
        .map_err(|_| "Claude credentials file not found. Run 'claude login' first.".to_string())?;

    let creds: CredentialsFile = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse credentials: {}", e))?;

    creds.claude_ai_oauth
        .and_then(|o| o.access_token)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| "No OAuth token found in credentials. Run 'claude login' first.".to_string())
}

/// Fetch usage from the Anthropic API
pub fn fetch_usage() -> UsageResponse {
    let now = chrono::Utc::now().to_rfc3339();

    let token = match read_oauth_token() {
        Ok(t) => t,
        Err(e) => {
            return UsageResponse {
                five_hour: None,
                seven_day: None,
                seven_day_opus: None,
                seven_day_sonnet: None,
                extra_usage: None,
                fetched_at: now,
                error: Some(e),
            };
        }
    };

    let result = ureq::get("https://api.anthropic.com/api/oauth/usage")
        .set("Authorization", &format!("Bearer {}", token))
        .set("anthropic-beta", "oauth-2025-04-20")
        .set("User-Agent", "agent-sessions/1.0.0")
        .call();

    match result {
        Ok(response) => {
            match response.into_json::<ApiResponse>() {
                Ok(api) => {
                    let usage = UsageResponse {
                        five_hour: api.five_hour.map(|w| UsageWindow {
                            utilization: w.utilization.unwrap_or(0.0),
                            resets_at: w.resets_at,
                        }),
                        seven_day: api.seven_day.map(|w| UsageWindow {
                            utilization: w.utilization.unwrap_or(0.0),
                            resets_at: w.resets_at,
                        }),
                        seven_day_opus: api.seven_day_opus.map(|w| UsageWindow {
                            utilization: w.utilization.unwrap_or(0.0),
                            resets_at: w.resets_at,
                        }),
                        seven_day_sonnet: api.seven_day_sonnet.map(|w| UsageWindow {
                            utilization: w.utilization.unwrap_or(0.0),
                            resets_at: w.resets_at,
                        }),
                        extra_usage: api.extra_usage.map(|e| ExtraUsage {
                            is_enabled: e.is_enabled.unwrap_or(false),
                            monthly_limit: e.monthly_limit.unwrap_or(0.0),
                            used_credits: e.used_credits.unwrap_or(0.0),
                        }),
                        fetched_at: now,
                        error: None,
                    };

                    // Cache the result
                    *USAGE_CACHE.lock().unwrap() = Some(usage.clone());
                    usage
                }
                Err(e) => UsageResponse {
                    five_hour: None, seven_day: None, seven_day_opus: None, seven_day_sonnet: None,
                    extra_usage: None, fetched_at: now, error: Some(format!("Failed to parse response: {}", e)),
                },
            }
        }
        Err(ureq::Error::Status(401, _)) => {
            // Token expired — try spawning `claude /status` to refresh
            let _ = std::process::Command::new("claude").arg("/status").spawn();
            UsageResponse {
                five_hour: None, seven_day: None, seven_day_opus: None, seven_day_sonnet: None,
                extra_usage: None, fetched_at: now, error: Some("Token expired. Refreshing... try again in a moment.".to_string()),
            }
        }
        Err(e) => UsageResponse {
            five_hour: None, seven_day: None, seven_day_opus: None, seven_day_sonnet: None,
            extra_usage: None, fetched_at: now, error: Some(format!("API request failed: {}", e)),
        },
    }
}

/// Get cached usage (returns None if never fetched)
pub fn get_cached_usage() -> Option<UsageResponse> {
    USAGE_CACHE.lock().unwrap().clone()
}

/// Decode a PNG from bytes into RGBA pixel data + dimensions
fn decode_png(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    buf.truncate(info.buffer_size());

    // Convert to RGBA if needed
    let (width, height) = (info.width, info.height);
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf,
        png::ColorType::Rgb => {
            let mut rgba = Vec::with_capacity(buf.len() / 3 * 4);
            for chunk in buf.chunks(3) {
                rgba.extend_from_slice(chunk);
                rgba.push(255);
            }
            rgba
        }
        _ => return None,
    };

    Some((rgba, width, height))
}

/// Generate a tray icon with a colored status dot based on usage level.
/// Returns RGBA bytes + width + height.
pub fn generate_tray_icon_with_dot(base_png: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let (mut rgba, width, height) = decode_png(base_png)?;

    // Determine dot color from cached usage
    let (r, g, b) = if let Some(usage) = get_cached_usage() {
        if usage.error.is_some() {
            (128, 128, 128) // gray — error/unavailable
        } else if let Some(ref fh) = usage.five_hour {
            if fh.utilization >= 90.0 {
                (239, 68, 68) // red
            } else if fh.utilization >= 70.0 {
                (245, 158, 11) // amber
            } else {
                (16, 185, 129) // green
            }
        } else {
            (128, 128, 128) // gray — no data
        }
    } else {
        return None; // No usage data yet — keep default icon
    };

    // Draw a filled circle in the bottom-right corner
    let dot_radius: i32 = (width.min(height) as i32) / 5; // ~20% of icon size
    let cx = width as i32 - dot_radius - 1;
    let cy = height as i32 - dot_radius - 1;

    for y in 0..height as i32 {
        for x in 0..width as i32 {
            let dx = x - cx;
            let dy = y - cy;
            let dist_sq = dx * dx + dy * dy;
            let radius_sq = dot_radius * dot_radius;

            if dist_sq <= radius_sq {
                let idx = ((y as u32 * width + x as u32) * 4) as usize;
                if idx + 3 < rgba.len() {
                    // Anti-aliased edge
                    let edge_dist = (dist_sq as f32).sqrt() - (dot_radius as f32 - 1.0);
                    let alpha = if edge_dist > 0.0 { (1.0 - edge_dist).max(0.0) } else { 1.0 };
                    let a = (alpha * 255.0) as u8;

                    // Alpha blend
                    let bg_r = rgba[idx];
                    let bg_g = rgba[idx + 1];
                    let bg_b = rgba[idx + 2];
                    let bg_a = rgba[idx + 3];

                    let out_a = a as u16 + (bg_a as u16 * (255 - a as u16) / 255);
                    if out_a > 0 {
                        rgba[idx] = ((r as u16 * a as u16 + bg_r as u16 * bg_a as u16 * (255 - a as u16) / 255) / out_a) as u8;
                        rgba[idx + 1] = ((g as u16 * a as u16 + bg_g as u16 * bg_a as u16 * (255 - a as u16) / 255) / out_a) as u8;
                        rgba[idx + 2] = ((b as u16 * a as u16 + bg_b as u16 * bg_a as u16 * (255 - a as u16) / 255) / out_a) as u8;
                        rgba[idx + 3] = out_a as u8;
                    }
                }
            }
        }
    }

    Some((rgba, width, height))
}
