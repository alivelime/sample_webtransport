// Licensed under the Apache License, Version 2.0 <LICENSE-APACHE or
// http://www.apache.org/licenses/LICENSE-2.0> or the MIT license
// <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. This file may not be copied, modified, or distributed
// except according to those terms.

#![cfg_attr(feature = "deny-warnings", deny(warnings))]
#![warn(clippy::use_self)]

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::io;
use std::mem;
use std::net::{SocketAddr, ToSocketAddrs};
use std::path::PathBuf;
use std::rc::Rc;
use std::time::{Duration, Instant};

use mio::net::UdpSocket;
use mio::{Events, Poll, PollOpt, Ready, Token};
use mio_extras::timer::{Builder, Timeout, Timer};
use structopt::StructOpt;

use neqo_common::{hex, qdebug, qinfo, qerror, Datagram, Header};
use neqo_crypto::{
    constants::{TLS_AES_128_GCM_SHA256, TLS_AES_256_GCM_SHA384, TLS_CHACHA20_POLY1305_SHA256},
    generate_ech_keys, init_db, random, AntiReplay, Cipher,
};
use neqo_http3::{
    Error, Http3Parameters, Http3Server, Http3ServerEvent, WebTransportRequest,
    WebTransportServerEvent,
};
use neqo_transport::{
    server::{ActiveConnectionRef, ValidateAddress},
    tparams::PreferredAddress,
    CongestionControlAlgorithm, ConnectionParameters, Output, RandomConnectionIdGenerator,
    StreamId, StreamType,
};

const TIMER_TOKEN: Token = Token(0xffff_ffff);
const ANTI_REPLAY_WINDOW: Duration = Duration::from_secs(10);

#[derive(Debug, StructOpt)]
#[structopt(name = "neqo-server", about = "A basic HTTP3 server.")]
struct Args {
    /// List of IP:port to listen on
    #[structopt(default_value = "[::]:4433")]
    hosts: Vec<String>,

    #[structopt(name = "encoder-table-size", long, default_value = "16384")]
    max_table_size_encoder: u64,

    #[structopt(name = "decoder-table-size", long, default_value = "16384")]
    max_table_size_decoder: u64,

    #[structopt(short = "b", long, default_value = "65535")]
    max_blocked_streams: u16,

    #[structopt(short = "d", long, default_value = "./nss_db", parse(from_os_str))]
    /// NSS database directory.
    db: PathBuf,

    #[structopt(short = "k", long, default_value = "Test Certificate")]
    /// Name of key from NSS database.
    key: String,

    #[structopt(short = "a", long, default_value = "h3")]
    /// ALPN labels to negotiate.
    ///
    /// This server still only does HTTP3 no matter what the ALPN says.
    alpn: String,

    #[structopt(name = "qlog-dir", long)]
    /// Enable QLOG logging and QLOG traces to this directory
    qlog_dir: Option<PathBuf>,

    #[structopt(flatten)]
    quic_parameters: QuicParameters,

    #[structopt(name = "retry", long)]
    /// Force a retry
    retry: bool,

    #[structopt(short = "c", long, number_of_values = 1)]
    /// The set of TLS cipher suites to enable.
    /// From: TLS_AES_128_GCM_SHA256, TLS_AES_256_GCM_SHA384, TLS_CHACHA20_POLY1305_SHA256.
    ciphers: Vec<String>,

    #[structopt(name = "preferred-address-v4", long)]
    /// An IPv4 address for the server preferred address.
    preferred_address_v4: Option<String>,

    #[structopt(name = "preferred-address-v6", long)]
    /// An IPv6 address for the server preferred address.
    preferred_address_v6: Option<String>,

    #[structopt(name = "ech", long)]
    /// Enable encrypted client hello (ECH).
    /// This generates a new set of ECH keys when it is invoked.
    /// The resulting configuration is printed to stdout in hexadecimal format.
    ech: bool,
}

impl Args {
    fn get_ciphers(&self) -> Vec<Cipher> {
        self.ciphers
            .iter()
            .filter_map(|c| match c.as_str() {
                "TLS_AES_128_GCM_SHA256" => Some(TLS_AES_128_GCM_SHA256),
                "TLS_AES_256_GCM_SHA384" => Some(TLS_AES_256_GCM_SHA384),
                "TLS_CHACHA20_POLY1305_SHA256" => Some(TLS_CHACHA20_POLY1305_SHA256),
                _ => None,
            })
            .collect::<Vec<_>>()
    }

    fn get_sock_addr<F>(opt: &Option<String>, v: &str, f: F) -> Option<SocketAddr>
    where
        F: FnMut(&SocketAddr) -> bool,
    {
        let addr = opt
            .iter()
            .flat_map(|spa| spa.to_socket_addrs().ok())
            .flatten()
            .find(f);
        if opt.is_some() != addr.is_some() {
            panic!(
                "unable to resolve '{}' to an {} address",
                opt.as_ref().unwrap(),
                v
            );
        }
        addr
    }

    fn preferred_address_v4(&self) -> Option<SocketAddr> {
        Self::get_sock_addr(&self.preferred_address_v4, "IPv4", |addr| addr.is_ipv4())
    }

    fn preferred_address_v6(&self) -> Option<SocketAddr> {
        Self::get_sock_addr(&self.preferred_address_v6, "IPv6", |addr| addr.is_ipv6())
    }

    fn preferred_address(&self) -> Option<PreferredAddress> {
        let v4 = self.preferred_address_v4();
        let v6 = self.preferred_address_v6();
        if v4.is_none() && v6.is_none() {
            None
        } else {
            Some(PreferredAddress::new(v4, v6))
        }
    }

    fn listen_addresses(&self) -> Vec<SocketAddr> {
        self.hosts
            .iter()
            .filter_map(|host| host.to_socket_addrs().ok())
            .flatten()
            .chain(self.preferred_address_v4())
            .chain(self.preferred_address_v6())
            .collect()
    }

    fn now(&self) -> Instant {
        Instant::now()
    }
}

#[derive(Debug, StructOpt)]
struct QuicParameters {
    #[structopt(long, default_value = "4294967296")]
    /// Set the MAX_STREAMS_BIDI limit.
    max_streams_bidi: u64,

    #[structopt(long, default_value = "4294967296")]
    /// Set the MAX_STREAMS_UNI limit.
    max_streams_uni: u64,

    #[structopt(long = "cc", default_value = "newreno")]
    /// The congestion controller to use.
    congestion_control: CongestionControlAlgorithm,
}

impl QuicParameters {
    fn get(&self) -> ConnectionParameters {
        ConnectionParameters::default()
            .max_streams(StreamType::BiDi, self.max_streams_bidi)
            .max_streams(StreamType::UniDi, self.max_streams_uni)
            .cc_algorithm(self.congestion_control)
    }
}

fn emit_packet(socket: &mut UdpSocket, out_dgram: Datagram) {
    let sent = socket
        .send_to(&out_dgram, &out_dgram.destination())
        .expect("Error sending datagram");
    if sent != out_dgram.len() {
        eprintln!("Unable to send all {} bytes of datagram", out_dgram.len());
    }
}

struct Publisher {
    // members identified by connection_id.
    members: HashMap<ActiveConnectionRef, WebTransportRequest>,

    // buffer data with stream_id.
    buf: HashMap<StreamId, Vec<u8>>,
}
impl Publisher {
    pub fn new() -> Self {
        Self {
            members: HashMap::new(),
            buf: HashMap::new(),
        }
    }
    pub fn subscribe(&mut self, handler: WebTransportRequest) {
        self.members.insert(handler.conn.clone(), handler);
    }
    pub fn leave(&mut self, conn: &ActiveConnectionRef) {
        self.members.remove(conn);
    }

    pub fn publish(&mut self, stream_id: StreamId, data: Vec<u8>, fin: bool) {
        if fin {
            let data = self.buf.remove(&stream_id).unwrap();
            println!("send {} bytes data.", data.len());

            // send data with new stream.
            for (_conn, handler) in self.members.iter_mut() {
                match handler.create_stream(StreamType::UniDi) {
                    Ok(mut stream) => {
                        stream.send_data(data.as_slice());
                        stream.stream_close_send();
                    },
                    Err(err) => {
                        qerror!("create stream error. {}", err)
                    },
                }
            }
        } else {
            // add buffer
            match self.buf.get_mut(&stream_id) {
                Some(b) => { b.extend(data); },
                None => {
                    self.buf.insert(stream_id, data);
                },
            };
        }
    }
    pub fn stop(&mut self, stream_id: &StreamId) {
        self.buf.remove(stream_id);
    }
}

pub enum MyHandler {
    PublishVideo,
    PublishAudio,
    SubscribeVideo,
    SubscribeAudio,
}

struct WebTransportServer {
    server: Http3Server,
    handler: HashMap<ActiveConnectionRef, MyHandler>,
    video_publisher: Publisher,
    audio_publisher: Publisher,
}
impl WebTransportServer {
    pub fn new(server: Http3Server) -> Self {
        Self {
            server,
            handler: HashMap::new(),
            video_publisher: Publisher::new(),
            audio_publisher: Publisher::new(),
        }
    }

    fn process(&mut self, dgram: Option<Datagram>, now: Instant) -> Output {
        self.server.process(dgram, now)
    }

    fn process_events(&mut self, _args: &Args, _now: Instant) {
        while let Some(event) = self.server.next_event() {
            // println!("{:#?}", event);
            match event {
                Http3ServerEvent::WebTransport(wt) => match wt {
                    WebTransportServerEvent::NewSession {
                        mut session,
                        headers,
                    } => {
                        println!("Headers (request={}): {:?}", session, headers);
                        match headers.iter().find(|&h| h.name() == ":path") {
                            Some(h) => match h.value() {
                                "/video/stream" => {
                                    self.handler
                                        .insert(session.conn.clone(), MyHandler::PublishVideo);
                                    let _ = session.response(true);
                                }
                                "/video/view" => {
                                    self.handler
                                        .insert(session.conn.clone(), MyHandler::SubscribeVideo);
                                    self.video_publisher.subscribe(session.clone());
                                    let _ = session.response(true);
                                }
                                "/audio/stream" => {
                                    self.handler
                                        .insert(session.conn.clone(), MyHandler::PublishAudio);
                                    let _ = session.response(true);
                                }
                                "/audio/view" => {
                                    self.handler
                                        .insert(session.conn.clone(), MyHandler::SubscribeAudio);
                                    self.audio_publisher.subscribe(session.clone());
                                    let _ = session.response(true);
                                }
                                "/chat" => {
                                    let _ = session.response(true);
                                }
                                _ => {
                                    let _ = session.send_headers(&[
                                        Header::new(":status", "404"),
                                        Header::new("sec-webtransport-http3-draft", "draft02"),
                                    ]);
                                }
                            },
                            None => {
                                let _ = session.cancel_fetch(Error::HttpRequestIncomplete.code());
                            }
                        }
                    }
                    WebTransportServerEvent::NewStream(_stream) => {
                        // バッファの作成はデータ追加時に行うのでここでは特に何もしない
                    }
                    WebTransportServerEvent::SessionClosed { session, error: _ } => {
                        match self.handler.get(&session.conn) {
                            Some(h) => match h {
                                MyHandler::PublishVideo => self.video_publisher.stop(&session.stream_id()),
                                MyHandler::PublishAudio => self.audio_publisher.stop(&session.stream_id()),
                                MyHandler::SubscribeVideo => {
                                    self.video_publisher.leave(&session.conn)
                                }
                                MyHandler::SubscribeAudio => {
                                    self.audio_publisher.leave(&session.conn)
                                }
                            },
                            None => {}
                        };
                        self.handler.remove(&session.conn);
                    }
                },
                Http3ServerEvent::Data { stream, data, fin } => {
                    match self.handler.get(&stream.conn) {
                        Some(h) => match h {
                            MyHandler::PublishVideo => {
                                self.video_publisher.publish(stream.stream_id(), data, fin)
                            }
                            MyHandler::PublishAudio => {
                                self.audio_publisher.publish(stream.stream_id(), data, fin)
                            }
                            _ => {}
                        },
                        None => {}
                    };
                }
                _ => {}
            }
        }
    }

    fn set_qlog_dir(&mut self, dir: Option<PathBuf>) {
        self.server.set_qlog_dir(dir)
    }

    fn validate_address(&mut self, v: ValidateAddress) {
        self.server.set_validation(v);
    }

    fn set_ciphers(&mut self, ciphers: &[Cipher]) {
        self.server.set_ciphers(ciphers);
    }

    fn enable_ech(&mut self) -> &[u8] {
        let (sk, pk) = generate_ech_keys().expect("should create ECH keys");
        self.server
            .enable_ech(random(1)[0], "public.example", &sk, &pk)
            .unwrap();
        self.server.ech_config()
    }
}

fn read_dgram(
    socket: &mut UdpSocket,
    local_address: &SocketAddr,
) -> Result<Option<Datagram>, io::Error> {
    let buf = &mut [0u8; 2048];
    let (sz, remote_addr) = match socket.recv_from(&mut buf[..]) {
        Err(ref err) if err.kind() == io::ErrorKind::WouldBlock => return Ok(None),
        Err(err) => {
            eprintln!("UDP recv error: {:?}", err);
            return Err(err);
        }
        Ok(res) => res,
    };

    if sz == buf.len() {
        eprintln!("Might have received more than {} bytes", buf.len());
    }

    if sz == 0 {
        eprintln!("zero length datagram received?");
        Ok(None)
    } else {
        Ok(Some(Datagram::new(remote_addr, *local_address, &buf[..sz])))
    }
}

struct ServersRunner {
    args: Args,
    poll: Poll,
    hosts: Vec<SocketAddr>,
    server: WebTransportServer,
    timeout: Option<Timeout>,
    sockets: Vec<UdpSocket>,
    active_sockets: HashSet<usize>,
    timer: Timer<usize>,
}

impl ServersRunner {
    pub fn new(args: Args) -> Result<Self, io::Error> {
        let server = Self::create_server(&args);
        let mut runner = Self {
            args,
            poll: Poll::new()?,
            hosts: Vec::new(),
            server,
            timeout: None,
            sockets: Vec::new(),
            active_sockets: HashSet::new(),
            timer: Builder::default()
                .tick_duration(Duration::from_millis(1))
                .build::<usize>(),
        };
        runner.init()?;
        Ok(runner)
    }

    /// Init Poll for all hosts. Create sockets, and a map of the
    /// socketaddrs to instances of the HttpServer handling that addr.
    fn init(&mut self) -> Result<(), io::Error> {
        self.hosts = self.args.listen_addresses();
        if self.hosts.is_empty() {
            eprintln!("No valid hosts defined");
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "No hosts"));
        }

        for (i, host) in self.hosts.iter().enumerate() {
            let socket = match UdpSocket::bind(host) {
                Err(err) => {
                    eprintln!("Unable to bind UDP socket: {}", err);
                    return Err(err);
                }
                Ok(s) => s,
            };

            let local_addr = match socket.local_addr() {
                Err(err) => {
                    eprintln!("Socket local address not bound: {}", err);
                    return Err(err);
                }
                Ok(s) => s,
            };

            let also_v4 = if socket.only_v6().unwrap_or(true) {
                ""
            } else {
                " as well as V4"
            };
            println!(
                "Server waiting for connection on: {:?}{}",
                local_addr, also_v4
            );

            self.poll.register(
                &socket,
                Token(i),
                Ready::readable() | Ready::writable(),
                PollOpt::edge(),
            )?;

            self.sockets.push(socket);
        }

        self.poll
            .register(&self.timer, TIMER_TOKEN, Ready::readable(), PollOpt::edge())?;

        Ok(())
    }

    fn create_server(args: &Args) -> WebTransportServer {
        // Note: this is the exception to the case where we use `Args::now`.
        let anti_replay = AntiReplay::new(Instant::now(), ANTI_REPLAY_WINDOW, 7, 14)
            .expect("unable to setup anti-replay");
        let cid_mgr = Rc::new(RefCell::new(RandomConnectionIdGenerator::new(10)));
        let mut svr = WebTransportServer::new({
            let mut server = Http3Server::new(
                args.now(),
                &[args.key.clone()],
                &[args.alpn.clone()],
                anti_replay,
                cid_mgr,
                Http3Parameters::default()
                    .max_table_size_encoder(args.max_table_size_encoder)
                    .max_table_size_decoder(args.max_table_size_decoder)
                    .max_blocked_streams(args.max_blocked_streams)
                    .webtransport(true),
                None,
            )
            .expect("We cannot make a server!");
            if let Some(spa) = args.preferred_address() {
                server.set_preferred_address(spa);
            }
            server
        });
        svr.set_ciphers(&args.get_ciphers());
        svr.set_qlog_dir(args.qlog_dir.clone());
        if args.retry {
            svr.validate_address(ValidateAddress::Always);
        }
        if args.ech {
            let cfg = svr.enable_ech();
            println!("ECHConfigList: {}", hex(cfg));
        }
        svr
    }

    /// Tries to find a socket, but then just falls back to sending from the first.
    fn find_socket(&mut self, addr: SocketAddr) -> &mut UdpSocket {
        let (first, rest) = self.sockets.split_first_mut().unwrap();
        rest.iter_mut()
            .find(|s| {
                s.local_addr()
                    .ok()
                    .map_or(false, |socket_addr| socket_addr == addr)
            })
            .unwrap_or(first)
    }

    fn process(&mut self, inx: usize, dgram: Option<Datagram>) -> bool {
        match self.server.process(dgram, self.args.now()) {
            Output::Datagram(dgram) => {
                let socket = self.find_socket(dgram.source());
                emit_packet(socket, dgram);
                true
            }
            Output::Callback(new_timeout) => {
                if let Some(to) = &self.timeout {
                    self.timer.cancel_timeout(to);
                }

                qinfo!("Setting timeout of {:?} for socket {}", new_timeout, inx);
                self.timeout = Some(self.timer.set_timeout(new_timeout, inx));
                false
            }
            Output::None => {
                qdebug!("Output::None");
                false
            }
        }
    }

    fn process_datagrams_and_events(
        &mut self,
        inx: usize,
        read_socket: bool,
    ) -> Result<(), io::Error> {
        if self.sockets.get_mut(inx).is_some() {
            if read_socket {
                loop {
                    let socket = self.sockets.get_mut(inx).unwrap();
                    let dgram = read_dgram(socket, &self.hosts[inx])?;
                    if dgram.is_none() {
                        break;
                    }
                    let _ = self.process(inx, dgram);
                }
            } else {
                let _ = self.process(inx, None);
            }
            self.server.process_events(&self.args, self.args.now());
            if self.process(inx, None) {
                self.active_sockets.insert(inx);
            }
        }
        Ok(())
    }

    fn process_active_conns(&mut self) -> Result<(), io::Error> {
        let curr_active = mem::take(&mut self.active_sockets);
        for inx in curr_active {
            self.process_datagrams_and_events(inx, false)?;
        }
        Ok(())
    }

    fn process_timeout(&mut self) -> Result<(), io::Error> {
        while let Some(inx) = self.timer.poll() {
            qinfo!("Timer expired for {:?}", inx);
            self.process_datagrams_and_events(inx, false)?;
        }
        Ok(())
    }

    pub fn run(&mut self) -> Result<(), io::Error> {
        let mut events = Events::with_capacity(1024);
        loop {
            // If there are active servers do not block in poll.
            self.poll.poll(
                &mut events,
                if self.active_sockets.is_empty() {
                    None
                } else {
                    Some(Duration::from_millis(0))
                },
            )?;

            for event in &events {
                if event.token() == TIMER_TOKEN {
                    self.process_timeout()?;
                } else {
                    if !event.readiness().is_readable() {
                        continue;
                    }
                    self.process_datagrams_and_events(event.token().0, true)?;
                }
            }
            self.process_active_conns()?;
        }
    }
}

fn main() -> Result<(), io::Error> {
    env_logger::init();
    const HQ_INTEROP: &str = "hq-interop";

    let args = Args::from_args();
    assert!(!args.key.is_empty(), "Need at least one key");

    init_db(args.db.clone());

    let mut servers_runner = ServersRunner::new(args)?;
    servers_runner.run()
}
