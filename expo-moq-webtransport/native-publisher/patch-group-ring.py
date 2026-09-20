#!/usr/bin/env python3
"""Keep ~15s of keyframe groups so AbsoluteStart rewind can be served by the publisher."""
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
if "state.history.push_back(reader)" in text:
    print(f"already patched {path}", file=sys.stderr)
    raise SystemExit(0)

old_import = "use std::{cmp, ops::Deref, sync::Arc};"
new_import = "use std::{cmp, collections::VecDeque, ops::Deref, sync::Arc};"
if old_import not in text:
    raise SystemExit(f"import block not found in {path}")
text = text.replace(old_import, new_import, 1)

old_state = """struct SubgroupsState {
    latest_subgroup_reader: Option<SubgroupReader>,
    epoch: u64, // Updated each time latest changes
    closed: Result<(), ServeError>,
}

impl Default for SubgroupsState {
    fn default() -> Self {
        Self {
            latest_subgroup_reader: None,
            epoch: 0,
            closed: Ok(()),
        }
    }
}"""
new_state = """struct SubgroupsState {
    latest_subgroup_reader: Option<SubgroupReader>,
    // Keyframe-led groups are ~1s. 18 groups is a bounded 10s rewind window plus headroom.
    history: VecDeque<SubgroupReader>,
    epoch: u64, // Updated each time latest changes
    closed: Result<(), ServeError>,
}

impl Default for SubgroupsState {
    fn default() -> Self {
        Self {
            latest_subgroup_reader: None,
            history: VecDeque::new(),
            epoch: 0,
            closed: Ok(()),
        }
    }
}"""
if old_state not in text:
    raise SystemExit(f"SubgroupsState block not found in {path}")
text = text.replace(old_state, new_state, 1)

old_assign = "            } else {\n                state.latest_subgroup_reader = Some(reader);\n            }\n        } else {\n            state.latest_subgroup_reader = Some(reader);\n        }\n\n        self.next_subgroup_id"
new_assign = """            } else {
                state.latest_subgroup_reader = Some(reader.clone());
            }
        } else {
            state.latest_subgroup_reader = Some(reader.clone());
        }

        state.history.push_back(reader);
        while state.history.len() > 18 { state.history.pop_front(); }

        self.next_subgroup_id"""
if old_assign not in text:
    # The Greater branch also assigns Some(reader) without clone
    old_assign = """                    cmp::Ordering::Greater => state.latest_subgroup_reader = Some(reader),
                }
            } else if writer.group_id.cmp(&latest.group_id) == cmp::Ordering::Greater {
                state.latest_subgroup_reader = Some(reader);
            } else {
                return Ok(writer); // drop here as well
            }
        } else {
            state.latest_subgroup_reader = Some(reader);
        }

        self.next_subgroup_id"""
    new_assign = """                    cmp::Ordering::Greater => state.latest_subgroup_reader = Some(reader.clone()),
                }
            } else if writer.group_id.cmp(&latest.group_id) == cmp::Ordering::Greater {
                state.latest_subgroup_reader = Some(reader.clone());
            } else {
                return Ok(writer); // drop here as well
            }
        } else {
            state.latest_subgroup_reader = Some(reader.clone());
        }

        state.history.push_back(reader);
        while state.history.len() > 18 { state.history.pop_front(); }

        self.next_subgroup_id"""
if old_assign not in text:
    raise SystemExit(f"create() reader assign block not found in {path}")
text = text.replace(old_assign, new_assign, 1)

old_reader = """pub struct SubgroupsReader {
    pub info: Arc<Track>,
    state: State<SubgroupsState>,
    epoch: u64,
}

impl SubgroupsReader {
    fn new(state: State<SubgroupsState>, track_info: Arc<Track>) -> Self {
        Self {
            info: track_info,
            state,
            epoch: 0,
        }
    }

    pub async fn next(&mut self) -> Result<Option<SubgroupReader>, ServeError> {
        loop {
            {
                let state = self.state.lock();

                if self.epoch != state.epoch {
                    self.epoch = state.epoch;
                    return Ok(state.latest_subgroup_reader.clone());
                }"""
new_reader = """pub struct SubgroupsReader {
    pub info: Arc<Track>,
    state: State<SubgroupsState>,
    epoch: u64,
    last_location: Option<(u64, u64)>,
}

impl SubgroupsReader {
    fn new(state: State<SubgroupsState>, track_info: Arc<Track>) -> Self {
        Self {
            info: track_info,
            state,
            epoch: 0,
            last_location: None,
        }
    }

    pub async fn next(&mut self) -> Result<Option<SubgroupReader>, ServeError> {
        loop {
            {
                let state = self.state.lock();

                if let Some(next) = state.history.iter().find(|group| {
                    self.last_location.map(|last| (group.group_id, group.subgroup_id) > last).unwrap_or(true)
                }) {
                    self.last_location = Some((next.group_id, next.subgroup_id));
                    self.epoch = state.epoch;
                    return Ok(Some(next.clone()));
                }"""
if old_reader not in text:
    raise SystemExit(f"SubgroupsReader next() block not found in {path}")
text = text.replace(old_reader, new_reader, 1)

path.write_text(text)
print(f"patched group ring into {path}", file=sys.stderr)
