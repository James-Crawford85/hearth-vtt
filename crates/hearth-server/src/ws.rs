use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures::{SinkExt, StreamExt};
use hearth_core::{ClientMsg, ServerMsg, User};
use tokio::sync::broadcast::error::RecvError;

use crate::state::AppState;

pub async fn handler(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> Response {
    ws.max_message_size(2 * 1024 * 1024).on_upgrade(move |socket| connection(socket, state))
}

fn encode(msg: &ServerMsg) -> Message {
    Message::Text(serde_json::to_string(msg).expect("server messages serialize").into())
}

async fn send<S: SinkExt<Message> + Unpin>(sink: &mut S, msg: &ServerMsg) -> bool {
    sink.send(encode(msg)).await.is_ok()
}

async fn connection(socket: WebSocket, state: Arc<AppState>) {
    let (mut sink, mut stream) = socket.split();

    // ---- handshake: the first message must be `join`
    let first = tokio::time::timeout(Duration::from_secs(30), stream.next()).await;
    let (name, key) = match first {
        Ok(Some(Ok(Message::Text(t)))) => match serde_json::from_str::<ClientMsg>(t.as_str()) {
            Ok(ClientMsg::Join { name, key }) => (name, key),
            _ => {
                let _ = send(&mut sink, &ServerMsg::Error { message: "expected join".into() }).await;
                return;
            }
        },
        _ => return,
    };
    let user = match state.join(&name, key.as_deref()).await {
        Ok(u) => u,
        Err(message) => {
            let _ = send(&mut sink, &ServerMsg::Error { message }).await;
            return;
        }
    };

    // Subscribe while holding the world lock so no event slips between the
    // snapshot and the subscription (all writers broadcast under the lock).
    let conn = state.next_conn_id();
    let (welcome, mut rx) = {
        let world = state.world.read().await;
        let rx = state.tx.subscribe();
        state.online.lock().unwrap().insert(conn, user.id.clone());
        let welcome = ServerMsg::Welcome {
            user: user.clone(),
            world: world.view_for(&user),
            packages: state.packages_for(&world),
            online: state.online_ids(),
        };
        (welcome, rx)
    };
    tracing::info!(user = %user.name, role = ?user.role, "joined");
    if send(&mut sink, &welcome).await {
        state.broadcast_presence();
        run(&state, &user, &mut sink, &mut stream, &mut rx).await;
    }

    state.online.lock().unwrap().remove(&conn);
    state.broadcast_presence();
    tracing::info!(user = %user.name, "left");
}

async fn run<S, R>(
    state: &AppState,
    user: &User,
    sink: &mut S,
    stream: &mut R,
    rx: &mut tokio::sync::broadcast::Receiver<Arc<crate::state::Event>>,
) where
    S: SinkExt<Message> + Unpin,
    R: StreamExt<Item = Result<Message, axum::Error>> + Unpin,
{
    loop {
        tokio::select! {
            incoming = stream.next() => {
                let text = match incoming {
                    Some(Ok(Message::Text(t))) => t,
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                    Some(Ok(_)) => continue,
                };
                let msg = match serde_json::from_str::<ClientMsg>(text.as_str()) {
                    Ok(m) => m,
                    Err(e) => {
                        if !send(sink, &ServerMsg::Error { message: format!("bad message: {e}") }).await {
                            return;
                        }
                        continue;
                    }
                };
                let (req, result) = match msg {
                    ClientMsg::Join { .. } => (None, Err("already joined".to_string())),
                    ClientMsg::Op { op, req } => (req, state.submit(user, op).await),
                    ClientMsg::Chat { content, speaker_actor } => (None, state.chat(user, &content, speaker_actor).await),
                    ClientMsg::Roll { formula, flavor, actor_id, gm_only } => {
                        (None, state.roll(user, &formula, flavor, actor_id, gm_only).await)
                    }
                    ClientMsg::Emit { channel, payload, to } => {
                        state.emit(user, channel, payload, to);
                        (None, Ok(()))
                    }
                };
                if let Err(reason) = result {
                    if !send(sink, &ServerMsg::Rejected { req, reason }).await {
                        return;
                    }
                }
            }
            event = rx.recv() => {
                match event {
                    Ok(ev) => {
                        if ev.wants(user) && !send(sink, &ev.msg).await {
                            return;
                        }
                    }
                    Err(RecvError::Lagged(n)) => {
                        // The client fell behind; it reconnects and gets a fresh snapshot.
                        tracing::warn!(user = %user.name, skipped = n, "client lagged, resyncing");
                        let _ = send(sink, &ServerMsg::Error { message: "resync".into() }).await;
                        return;
                    }
                    Err(RecvError::Closed) => return,
                }
            }
        }
    }
}
