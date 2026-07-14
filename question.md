# auto_multipath_forward.py 输出目录结构进化问题记录

## 背景

当前本地可视化软件位于：

```text
D:\A-document\mtDNA\tools
```

软件目前是针对 `auto_multipath_forward.py` 的现有输出目录做可视化，而不是重新设计一个完全独立的数据格式。因此，后续优化重点不是推翻已有结果目录，而是在保持现有过程输出可追溯的基础上，让程序额外输出一层稳定、轻量、面向可视化读取的索引接口。

远端脚本位置：

```text
/share/home/yding25/mtDNA/MH63_auto/auto_multipath_forward.py
```

当前输出目录中包含大量中间过程文件，例如：

```text
paths/path_000001/round_02/candidates/normal/
paths/path_000001/round_02/candidates/site_0001/
paths/path_000001/round_02/candidates/circular_site_0001/
```

这些目录对人工排查很有用，但前端可视化如果直接递归读取这些过程目录，会面临路径规则复杂、文件命名容易变化、后续新增逻辑难以兼容的问题。

## 当前问题

1. 输出目录偏过程型，不是接口型。
2. 前端需要知道太多内部目录规则。
3. `normal`、`site_0001`、`circular_site_0001`、terminal stop、final path 等信息分散在多个文件中。
4. BAM/BAI/CRAM/CRAI/FA/FAI 等重文件和 TSV/JSON/TXT 等轻量索引文件混在一起。
5. 新增 circular branch 之后，路径分支类型更多，如果没有统一索引层，前端会越来越难维护。
6. IGV track 的 ref/alignment 路径不应该由前端硬猜，应该由程序输出标准表。

## 目标

让 `auto_multipath_forward.py` 在保留原始详细输出的同时，额外生成一个稳定的可视化接口目录：

```text
run_root/viz/
```

前端软件优先读取 `viz/` 下的标准文件，而不是直接解析所有中间过程目录。

## 建议新增目录

```text
run_root/
├── paths/                         # 保留现有详细过程输出
├── auto_round_*.summary.tsv        # 保留现有 round summary
├── final_path/                     # 保留现有最终路径结果
└── viz/                            # 新增：可视化标准接口层
    ├── manifest.json
    ├── tree_data.json
    ├── nodes.tsv
    ├── edges.tsv
    ├── paths.tsv
    ├── rounds.tsv
    ├── candidates.tsv
    ├── clip_sites.tsv
    ├── circular_sites.tsv
    ├── final_paths.tsv
    ├── read_sets.tsv
    └── igv_tracks.tsv
```

## 建议文件说明

### manifest.json

可视化入口文件，记录本次运行的基本信息和各索引文件路径。

建议字段：

```json
{
  "format_version": "2",
  "sample": "MH63",
  "run_id": "auto_multipath_xxx",
  "script": "auto_multipath_forward.py",
  "tree_data": "viz/tree_data.json",
  "nodes": "viz/nodes.tsv",
  "edges": "viz/edges.tsv",
  "candidates": "viz/candidates.tsv",
  "clip_sites": "viz/clip_sites.tsv",
  "circular_sites": "viz/circular_sites.tsv",
  "igv_tracks": "viz/igv_tracks.tsv"
}
```

### nodes.tsv

每个可视化节点一行。

建议字段：

```text
node_id
path_id
round
candidate_id
candidate_type
status
ref_len
support_reads
no_clip_reads
clip_reads
terminal_clip_reads
stop_reason
dir
```

`candidate_type` 建议包括：

```text
initial
normal
clip_branch
circular_branch
final
terminal
```

这样 `circular_site_0001` 可以和 `normal`、`site_0001`、`site_0002` 等节点并列显示。

### edges.tsv

记录节点之间的连接关系。

建议字段：

```text
source_node
target_node
edge_type
source_candidate
new_path_id
support_reads
status
```

`edge_type` 建议包括：

```text
normal_extend
clip_branch
circular_branch
terminal_stop
```

### candidates.tsv

汇总所有 round 的 `candidate_selection.tsv`，避免前端逐个目录查找。

建议字段至少包括：

```text
path_id
round
candidate_id
candidate_type
source_site
rep_read
ref_len
support_reads
no_clip_reads
clip_reads
terminal_clip_reads
status
candidate_dir
```

### clip_sites.tsv

汇总所有 clip site。

建议字段：

```text
path_id
round
site_id
site_center
support_reads
clip_side
representative_read
candidate_dir
forward_candidate
circular_candidate
```

### circular_sites.tsv

专门记录新增的 circular signal 判断结果。

建议字段：

```text
path_id
round
site_id
circular_candidate_id
circular_ref
circular_reads
non_circular_reads
signal_class
status
site_signal_summary
site_signal_reads
```

这里要体现当前讨论确定的逻辑：

- circular candidate 是从原始 clip site 中分出来的独立候选。
- `circular_site_0001` 应与 `normal`、`site_0001`、`site_0002` 并列。
- 原始 `site_0001` 后续 forward branch 的支持 reads 应排除 circular reads。
- circular 和 non-circular 都保留，不做二选一。

### read_sets.tsv

统一登记 reads 集合文件，方便软件或后续脚本读取。

建议字段：

```text
read_set_id
path_id
round
candidate_id
site_id
read_class
count
file
```

`read_class` 可包括：

```text
strict
no_clip
clip
terminal_clip
circular
non_circular
final_support
```

### igv_tracks.tsv

给 IGV 使用的标准 track 索引，避免前端硬编码路径。

建议字段：

```text
track_id
node_id
path_id
round
candidate_id
track_type
label
ref_fa
ref_fai
bam
bai
cram
crai
read_set
```

## 设计原则

1. 保留现有 `paths/` 详细输出，作为原始证据和 debug 目录。
2. 新增 `viz/` 作为稳定接口层，给前端直接读取。
3. 前端尽量只依赖 `manifest.json` 和 `viz/*.tsv/json`。
4. 所有路径类型、候选类型、终止原因都应该在表格中显式记录。
5. BAM/CRAM/FA 等大文件不需要复制到 `viz/`，但路径必须在 `igv_tracks.tsv` 中登记。
6. 后续新增逻辑，例如 circular branch、rollback、terminal head repeat，只需要增加 `candidate_type` / `edge_type` / `status`，不应破坏旧前端。

## 建议实现方式

在 `auto_multipath_forward.py` 中新增一组轻量写出函数，例如：

```text
init_viz_export(run_root)
append_viz_node(...)
append_viz_edge(...)
append_viz_candidate(...)
append_viz_clip_site(...)
append_viz_circular_site(...)
append_viz_read_set(...)
append_viz_igv_track(...)
finalize_viz_manifest(...)
```

这些函数只负责写索引，不改变现有分析逻辑。

## 优先级建议

第一阶段：只新增 `viz/manifest.json`、`viz/nodes.tsv`、`viz/edges.tsv`、`viz/candidates.tsv`、`viz/circular_sites.tsv`、`viz/igv_tracks.tsv`。

第二阶段：再补充 `read_sets.tsv`、`clip_sites.tsv`、`paths.tsv`、`rounds.tsv`、`final_paths.tsv`。

第三阶段：前端软件逐步从旧路径硬编码迁移到读取 `viz/manifest.json`。

## 当前结论

目前 `auto_multipath_forward.py` 的结果目录适合人工排查，但还不够适合作为长期稳定的可视化数据接口。

推荐方向是：

```text
保留 raw 输出 + 增加 viz 标准索引层
```

这样既不影响已有结果复查，也能让本地可视化软件后续稳定读取、显示和打开 IGV track。
