// A child that is alive and never answers `load`: the handshake deadline's one test subject.
import { connect } from "node:net";
connect({ fd: 3 }).resume();
