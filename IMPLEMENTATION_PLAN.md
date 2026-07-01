# 线粒体延申可视化工具：前后端分离 + IGV 集成

## 实现方案文档

---

## 1. 项目结构

```
/share/home/yding25/mtDNA/MH63_auto/roundtree_frontend/
├── start.sh                      # 一键启动脚本
├── generate_tree_data.py         # 后端：从 TSV 生成 tree_data.json
├── data/
│   └── tree_data.json            # 生成的树数据（含 IGV URL 配置）
├── index.html                    # 入口页面
├── css/
│   └── style.css                 # 全局样式
├── js/
│   ├── config.js                 # 常量配置（颜色、尺寸、URL等）
│   ├── app.js                    # 主入口，模块初始化和事件总线
│   ├── data-loader.js            # 加载 tree_data.json，构建查询索引
│   ├── layout.js                 # 自定义树布局算法（按 round 横向对齐）
│   ├── render.js                 # D3/SVG 渲染节点、边、标签
│   ├── interaction.js            # 缩放、平移、悬停、点击事件
│   ├── detail-panel.js           # 右侧滑动详情面板
│   ├── toolbar.js                # 筛选（round/path）、搜索、导出按钮
│   ├── igv-controller.js         # igv.js 生命周期管理（创建/销毁/切换）
│   └── export.js                 # SVG/PNG 导出
```

---

## 2. 后端：generate_tree_data.py

### 2.1 设计思路

**不重复造轮子**。现有脚本 `build_round_tree_clip_rollback_attempts.py` 中的 `collect_tree()` 函数已经能产出完整的树数据结构（nodes + edges + edge_info + tree）。新脚本直接 import 该函数，只在其产出之上做两件事：

1. 为每个 node 附加 `urls` 字段（供前端 IGV 使用的文件路径）
2. 构建 `final_paths_igv` 数组（供前端做 path 级别的 IGV 展示）

### 2.2 核心逻辑

```python
# generate_tree_data.py 伪代码

import sys
sys.path.insert(0, '/share/home/yding25/mtDNA/MH63_auto/tree_python_scripts')
from build_round_tree_clip_rollback_attempts import collect_tree, read_tsv, parse_nodes

def make_relative_url(absolute_path, serve_root):
    """将绝对路径转为相对于 HTTP 服务根的 URL 路径"""
    return str(Path(absolute_path).relative_to(serve_root))

def enrich_node_urls(node, serve_root):
    """为 node 补充 urls 字段"""
    urls = {}
    if node.get('ref_fa'):
        urls['ref_fa'] = make_relative_url(node['ref_fa'], serve_root)
    if node.get('final_dir'):
        final = Path(node['final_dir'])
        urls['final_dir'] = make_relative_url(str(final), serve_root)
        # 扫描 final_dir 下的 BAM 文件
        bams = []
        for pattern in ['*.bam']:
            for bam in final.glob(pattern):
                bams.append(make_relative_url(str(bam), serve_root))
        urls['bam_files'] = bams
    if node.get('round_dir'):
        urls['round_dir'] = make_relative_url(node['round_dir'], serve_root)
    node['urls'] = urls

def build_final_paths_igv(data, root, serve_root):
    """为每条 final path 构建 IGV 所需的 round 序列数据"""
    final_paths_tsv = read_tsv(root / 'final_paths_visible_round_nodes.tsv')
    result = []
    for row in final_paths_tsv:
        fp = row['final_path']
        rounds = []
        node_names = parse_nodes(row.get('visible_round_nodes', ''))
        dir_names = parse_nodes(row.get('visible_round_dirs', ''))
        for node_name, dir_name in zip(node_names, dir_names):
            round_dir = root / dir_name / 'final'
            ref_fa = round_dir / 'ref.fa'
            bam = round_dir / 'path_support_reads_vs_ref.bam'
            bai = round_dir / 'path_support_reads_vs_ref.bam.bai'
            rounds.append({
                'node_id': node_name,
                'round': data['nodes'].get(node_name, {}).get('round'),
                'ref_fa_url': make_relative_url(str(ref_fa), serve_root) if ref_fa.exists() else None,
                'bam_url': make_relative_url(str(bam), serve_root) if bam.exists() else None,
                'bam_index_url': make_relative_url(str(bai), serve_root) if bai.exists() else None,
            })
        result.append({'final_path': fp, 'rounds': rounds})
    data['final_paths_igv'] = result

def main():
    args = parse_args()
    root = Path(args.root)
    serve_root = Path(args.serve_root)
    
    # 复用现有逻辑
    data = collect_tree(root)
    
    # 补充 URL 字段
    for node_id, node in data['nodes'].items():
        enrich_node_urls(node, serve_root)
    
    # 补充 path IGV 数据
    build_final_paths_igv(data, root, serve_root)
    
    # 写入 JSON
    with open(args.out, 'w') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
```

### 2.3 命令行参数

| 参数 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `--root` | 是 | - | pipeline 根目录路径 |
| `--out` | 否 | `./data/tree_data.json` | JSON 输出路径 |
| `--serve-root` | 否 | `/share/home/yding25/mtDNA` | HTTP 服务文件系统根目录 |
| `--http-base` | 否 | `http://localhost:8765` | HTTP 服务 URL 前缀 |

---

## 3. 文件服务策略

### 3.1 为什么需要 HTTP 服务

igv.js 通过 HTTP 加载 BAM/FASTA 文件（需要 Range 请求支持随机读取）。浏览器无法直接通过 `file://` 协议加载 BAM 文件。

### 3.2 方案：Python http.server + CORS

```bash
# start.sh 核心逻辑
cd /share/home/yding25/mtDNA
python3 -c "
import http.server
import socketserver

class CORSHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

port = 8765
with socketserver.TCPServer(('', port), CORSHandler) as httpd:
    print(f'HTTP server at http://localhost:{port}')
    httpd.serve_forever()
"
```

服务根目录：`/share/home/yding25/mtDNA`

**URL 映射示例**：
- 文件：`/share/home/yding25/mtDNA/MH63_auto/.../round_05_1_1/final/ref.fa`
- URL：`http://localhost:8765/MH63_auto/.../round_05_1_1/final/ref.fa`

### 3.3 优势

- 零依赖，Python 标准库即可
- `SimpleHTTPRequestHandler` 原生支持 `Range` 头（BAM 随机读取必需）
- 单端口服务前端 HTML/JS + 后端数据文件

---

## 4. 前端数据流

### 4.1 tree_data.json 结构（由后端生成）

```javascript
{
  "summary": {
    "node_count": 290,
    "edge_count": 289,
    "path_count": 36,
    "clip_rollback_attempt_count": 26,
    "root": "/share/home/...",
    "selected_final_count": 36,
    "rolled_back_count": 26
  },
  
  "nodes": {
    "round_03_3": {
      "id": "round_03_3",
      "label": "round_03_3",
      "path_id": "path_000004",
      "round": 3,
      "status": "ACTIVE",
      "ref_len": "61331",
      "parent_path_id": "path_000001",
      "split_round": "NA",
      "split_candidate": "3",
      "terminal_paths": "path_014,path_015,...",
      "num_terminal_paths_through_node": "11",
      "ref_fa": "/share/.../round_03_3/final/ref.fa",
      "candidates": [],
      "description": "稳定延申 round 节点。",
      // --- 后端新增字段 ---
      "urls": {
        "ref_fa": "MH63_auto/.../round_03_3/final/ref.fa",
        "final_dir": "MH63_auto/.../round_03_3/final",
        "bam_files": [
          "MH63_auto/.../round_03_3/final/path_support_reads_vs_ref.bam"
        ]
      }
    },
    
    "clip_rollback_attempt__path_000004__r04": {
      "id": "clip_rollback_attempt__path_000004__r04",
      "label": "rollback_r04",
      "round": 4,
      "status": "CLIP_ROLLBACK_ATTEMPT",
      "ref_len": "61331",
      "parent_path_id": "path_000004",
      "split_round": "4",
      "split_candidate": "normal,site_0001",
      "candidates": [...],
      "description": "延申到 round 4 时出现 clip/分叉信号...",
      // --- 后端新增字段 ---
      "urls": {
        "round_dir": "MH63_auto/.../_internal_paths/path_000004/round_03",
        "final_dir": "MH63_auto/.../_internal_paths/path_000004/round_03/final",
        "ref_fa": "MH63_auto/.../round_03_3/final/ref.fa",
        "bam_files": [...]
      }
    }
  },
  
  "edges": [
    {
      "id": "round_03_3__TO__clip_rollback_attempt__path_000004__r04",
      "source": "round_03_3",
      "target": "clip_rollback_attempt__path_000004__r04",
      "kind": "rollback_attempt"
    }
  ],
  
  "edge_info": {
    "round_03_3__TO__clip_rollback_attempt__path_000004__r04": {
      "id": "...",
      "source": "round_03_3",
      "target": "clip_rollback_attempt__path_000004__r04",
      "kind": "rollback_attempt",
      "visual_kind": "rollback_attempt",
      "source_label": "round_03_3",
      "target_label": "rollback_r04",
      "split_candidate": "normal,site_0001",
      "split_mode": "clip_triggered_branch",
      "branch_color": ""
    }
  },
  
  "tree": {
    "id": "round_00",
    "label": "round_00",
    "status": "ACTIVE",
    "path_id": "path_000001",
    "round": 0,
    "children": [
      {
        "id": "round_01",
        "children": [
          {
            "id": "clip_rollback_attempt__path_000001__r02",
            "children": [
              {"id": "round_02_1", "children": [...]},
              {"id": "round_02_2", "children": [...]},
              {"id": "round_02_3", "children": [...]},
              {"id": "round_02_4", "children": [...]}
            ]
          }
        ]
      }
    ]
  },
  
  // --- 后端新增字段 ---
  "final_paths_igv": [
    {
      "final_path": "path_014",
      "rounds": [
        {
          "node_id": "round_00",
          "round": 0,
          "ref_fa_url": "MH63_auto/.../path_014/round_00/final/ref.fa",
          "bam_url": "MH63_auto/.../path_014/round_00/final/path_support_reads_vs_ref.bam",
          "bam_index_url": "MH63_auto/.../path_014/round_00/final/path_support_reads_vs_ref.bam.bai"
        },
        ...
      ]
    }
  ]
}
```

### 4.2 前端加载流程

```
index.html 加载
  → config.js 读取常量
  → data-loader.js fetch tree_data.json
    → 构建索引 Map：
      - nodesById:  Map<node_id, node>
      - edgesBySource: Map<source_id, edge[]>
      - edgesByTarget: Map<target_id, edge[]>
      - edgesById: Map<edge_id, edge_info>
      - nodesByRound: Map<round, node[]>
      - nodesByPath: Map<path_id, node[]>
  → app.js 初始化各模块
    → layout.js 执行布局算法
    → render.js 渲染 SVG
    → interaction.js 绑定事件
    → toolbar.js 初始化筛选器
    → igv-controller.js 初始化 igv.js
```

---

## 5. 前端各模块详细设计

### 5.1 config.js — 全局常量

```javascript
const CONFIG = {
    // --- 数据源 ---
    dataUrl: 'data/tree_data.json',
    httpBase: 'http://localhost:8765',   // igv.js 加载文件时的 URL 前缀
    
    // --- 布局参数 ---
    layout: {
        leftPadding: 120,
        topPadding: 120,
        xGapPerRound: 230,              // 每个 round 的水平间距
        yGapPerLeaf: 108,               // 叶子节点垂直间距
        nodeRadius: 10,                 // 稳定节点圆形半径
        labelOffsetX: 20,               // 标签距节点右侧偏移
        rollbackXOffset: -0.42,         // rollback 节点在 round 之间的偏移比例
    },
    
    // --- 节点颜色 ---
    statusColors: {
        'ACTIVE': '#2563eb',            // 蓝色
        'ROUND_DONE': '#2563eb',
        'BRANCHED': '#f08a24',          // 橙色
        'STOP_LOW_NOCLIP_SUPPORT': '#dc2626',  // 红色
        'STOP_NO_STRICT_3PRIME': '#dc2626',
        'STOP_UNRESOLVED_CLIP': '#dc2626',
        'STOP_NO_RESCUE_TIER_CANDIDATE': '#dc2626',
        'CLIP_ROLLBACK_ATTEMPT': '#fff7ed',    // 浅橙
        'default': '#64748b',           // 灰色
    },
    
    // --- rollback 节点样式 ---
    rollback: {
        shape: 'circle',                // 'circle' 或 'diamond'
        fill: '#fff7ed',
        stroke: '#f08a24',
        strokeWidth: 4,
        strokeDasharray: '6,5',
        radius: 10,
    },
    
    // --- 边样式 ---
    edgeStyles: {
        'same_path':        { stroke: '#aebbd1', strokeWidth: 3.0, dasharray: null },
        'rollback_attempt': { stroke: '#f08a24', strokeWidth: 3.2, dasharray: '10,8' },
        'spawn':            { stroke: null,       strokeWidth: 4.8, dasharray: null },
    },
    
    // --- 分支颜色（对应 site_0001, site_0002...） ---
    branchColors: [
        '#2563eb',  // normal/site_0001 → 蓝色
        '#d97706',  // site_0002 → 橙色
        '#059669',  // site_0003 → 绿色
        '#dc2626',  // site_0004 → 红色
        '#7c3aed',  // site_0005 → 紫色
        '#0891b2',  // site_0006 → 青色
        '#db2777',  // site_0007 → 粉色
    ],
    
    // --- 缩放范围 ---
    zoom: {
        min: 0.18,
        max: 3.5,
        step: 0.4,
    },
    
    // --- IGV 面板 ---
    igv: {
        defaultHeight: 400,
        minHeight: 150,
    },
};
```

### 5.2 data-loader.js — 数据加载与索引

```javascript
const DataLoader = {
    async load(url) {
        const resp = await fetch(url);
        const data = await resp.json();
        
        // 构建查询索引
        data._nodeById = new Map();
        data._edgesBySource = new Map();
        data._edgesByTarget = new Map();
        data._edgeById = new Map();
        data._nodesByRound = new Map();
        data._nodesByPath = new Map();
        
        for (const [id, node] of Object.entries(data.nodes)) {
            data._nodeById.set(id, node);
            
            // 按 round 索引
            const r = node.round;
            if (!data._nodesByRound.has(r)) data._nodesByRound.set(r, []);
            data._nodesByRound.get(r).push(node);
            
            // 按 path 索引
            const pid = node.path_id;
            if (!data._nodesByPath.has(pid)) data._nodesByPath.set(pid, []);
            data._nodesByPath.get(pid).push(node);
        }
        
        for (const edge of data.edges) {
            data._edgeById.set(edge.id, edge);
            
            if (!data._edgesBySource.has(edge.source))
                data._edgesBySource.set(edge.source, []);
            data._edgesBySource.get(edge.source).push(edge);
            
            if (!data._edgesByTarget.has(edge.target))
                data._edgesByTarget.set(edge.target, []);
            data._edgesByTarget.get(edge.target).push(edge);
        }
        
        return data;
    }
};
```

### 5.3 layout.js — 自定义树布局算法

**关键设计决策**：不使用 `d3.tree()`，因为它的 X 是按深度递增的，而我们需要按 round 编号对齐。自定义布局更简单直接。

```javascript
const TreeLayout = {
    layout(rootNode, data) {
        const leafCounter = { count: 0 };
        this._layoutRecursive(rootNode, data, leafCounter);
    },
    
    _layoutRecursive(node, data, leafCounter) {
        const nodeData = data._nodeById.get(node.id);
        const round = nodeData ? nodeData.round : 0;
        const isRollback = nodeData && 
            String(nodeData.status || '').includes('CLIP_ROLLBACK_ATTEMPT');
        
        // X 坐标：按 round 对齐，rollback 节点偏移
        if (isRollback) {
            node.x = CONFIG.layout.leftPadding + 
                (round + CONFIG.layout.rollbackXOffset) * CONFIG.layout.xGapPerRound;
        } else {
            node.x = CONFIG.layout.leftPadding + 
                round * CONFIG.layout.xGapPerRound;
        }
        
        // Y 坐标：叶子节点自底向上，父节点取子节点均值
        if (!node.children || node.children.length === 0) {
            node.y = CONFIG.layout.topPadding + 
                leafCounter.count * CONFIG.layout.yGapPerLeaf;
            leafCounter.count++;
        } else {
            for (const child of node.children) {
                this._layoutRecursive(child, data, leafCounter);
            }
            const sumY = node.children.reduce((s, c) => s + c.y, 0);
            node.y = sumY / node.children.length;
        }
    },
    
    // 展平树为节点列表（用于 D3 data join）
    flattenTree(rootNode) {
        const nodes = [];
        const queue = [rootNode];
        while (queue.length > 0) {
            const node = queue.shift();
            nodes.push(node);
            if (node.children) {
                queue.push(...node.children);
            }
        }
        return nodes;
    },
    
    // 收集所有边（用于 D3 data join）
    collectLinks(rootNode) {
        const links = [];
        const queue = [rootNode];
        while (queue.length > 0) {
            const node = queue.shift();
            if (node.children) {
                for (const child of node.children) {
                    links.push({
                        source: node,
                        target: child,
                        id: `${node.id}__TO__${child.id}`,
                    });
                    queue.push(child);
                }
            }
        }
        return links;
    }
};
```

**布局示意图**：

```
X: leftPadding=120                   round列间距=230px
    |                                    |
    v                                    v
    round_00    round_01    rollback_r02   round_02_1   round_03_1 ...
    x=120       x=350       x=593          x=580        x=810
                            (offset=-0.42)
```

### 5.4 render.js — D3/SVG 渲染

#### 5.4.1 节点渲染

```javascript
function renderNodes(svg, nodes, data) {
    const nodeGroup = svg.select('#node-group');
    
    const selection = nodeGroup.selectAll('g.node')
        .data(nodes, d => d.id)
        .join('g')
        .attr('class', d => {
            const nd = data._nodeById.get(d.id);
            const isRollback = nd && String(nd.status).includes('CLIP_ROLLBACK_ATTEMPT');
            return `node ${isRollback ? 'rollback-node' : 'round-node'}`;
        })
        .attr('transform', d => `translate(${d.x}, ${d.y})`);
    
    // 稳定 round 节点：实心圆
    selection.filter(d => {
        const nd = data._nodeById.get(d.id);
        return !nd || !String(nd.status).includes('CLIP_ROLLBACK_ATTEMPT');
    }).each(function(d) {
        const nd = data._nodeById.get(d.id);
        const color = CONFIG.statusColors[nd?.status] || CONFIG.statusColors.default;
        d3.select(this).append('circle')
            .attr('r', CONFIG.layout.nodeRadius)
            .attr('fill', color)
            .attr('stroke', '#fff')
            .attr('stroke-width', 2.2);
        d3.select(this).append('text')
            .attr('x', CONFIG.layout.labelOffsetX)
            .attr('y', 4)
            .attr('class', 'node-label')
            .text(d.label || d.id);
    });
    
    // rollback 节点：虚线橙色圆
    selection.filter(d => {
        const nd = data._nodeById.get(d.id);
        return nd && String(nd.status).includes('CLIP_ROLLBACK_ATTEMPT');
    }).each(function(d) {
        d3.select(this).append('circle')
            .attr('r', CONFIG.rollback.radius)
            .attr('fill', CONFIG.rollback.fill)
            .attr('stroke', CONFIG.rollback.stroke)
            .attr('stroke-width', CONFIG.rollback.strokeWidth)
            .attr('stroke-dasharray', CONFIG.rollback.strokeDasharray);
        d3.select(this).append('text')
            .attr('x', CONFIG.layout.labelOffsetX)
            .attr('y', 4)
            .attr('class', 'node-label rollback-label')
            .text(d.label || d.id);
    });
}
```

#### 5.4.2 边渲染

```javascript
function renderEdges(svg, links, data) {
    const linkGroup = svg.select('#link-group');
    
    linkGroup.selectAll('path.link')
        .data(links, d => d.id)
        .join('path')
        .attr('class', d => `link link-${d._edgeKind}`)
        .attr('d', d => {
            // 三次贝塞尔曲线
            const sx = d.source.x + CONFIG.layout.nodeRadius;
            const sy = d.source.y;
            const tx = d.target.x - CONFIG.layout.nodeRadius;
            const ty = d.target.y;
            const dx = (tx - sx) * 0.5;
            return `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
        })
        .attr('fill', 'none')
        .attr('stroke', d => d._stroke)
        .attr('stroke-width', d => d._strokeWidth)
        .attr('stroke-dasharray', d => d._dasharray || null);
    
    // 边的种类和颜色通过 edge_info 查询
}
```

#### 5.4.3 标签截断

```javascript
function formatLabel(label, maxLen = 20) {
    if (label.length <= maxLen) return label;
    // 截断中间部分：round_37_1_1...2_1
    const parts = label.split('_');
    if (parts.length <= 6) return label;
    return parts.slice(0, 3).join('_') + '...' + parts.slice(-2).join('_');
}
```

### 5.5 interaction.js — 缩放与平移

#### 5.5.1 缩放实现

```javascript
class TreeInteraction {
    constructor(svgContainer) {
        this.container = svgContainer;      // 外层 div（有 overflow: auto）
        this.svg = d3.select('#tree-svg');
        this.scale = 1.0;
    }
    
    // Ctrl + 滚轮缩放
    onWheel(event) {
        if (!event.ctrlKey) return;  // 普通滚轮滚动不处理
        event.preventDefault();
        
        const delta = event.deltaY > 0 ? -0.2 : 0.2;
        const newScale = Math.max(CONFIG.zoom.min, 
            Math.min(CONFIG.zoom.max, this.scale + delta));
        
        // 以鼠标位置为中心缩放
        const rect = this.container.getBoundingClientRect();
        const mx = event.clientX - rect.left + this.container.scrollLeft;
        const my = event.clientY - rect.top + this.container.scrollTop;
        
        const ratio = newScale / this.scale;
        this.container.scrollLeft = mx * ratio - (event.clientX - rect.left);
        this.container.scrollTop = my * ratio - (event.clientY - rect.top);
        
        this.scale = newScale;
        this.applyScale();
    }
    
    applyScale() {
        // 通过修改 SVG 的 CSS width/height 实现缩放
        // viewBox 不变，只改渲染尺寸
        this.svg.style('width', `${this.baseWidth * this.scale}px`);
        this.svg.style('height', `${this.baseHeight * this.scale}px`);
    }
    
    // 鼠标拖拽平移
    onDragStart(event) { /* 记录起始位置 */ }
    onDragMove(event) { /* 调整 scrollLeft/scrollTop */ }
    
    // Fit：缩放到适配视口宽度
    fitView() {
        const containerWidth = this.container.clientWidth;
        const svgWidth = this.baseWidth;
        this.scale = Math.max(0.2, containerWidth / svgWidth);
        this.applyScale();
    }
    
    resetView() {
        this.scale = 1.0;
        this.container.scrollLeft = 0;
        this.container.scrollTop = 0;
        this.applyScale();
    }
}
```

#### 5.5.2 点击事件

```javascript
// 节点点击 → 更新全局状态 → detail-panel 打开 + IGV 联动
function onNodeClick(nodeId, data) {
    appState.selectedNodeId = nodeId;
    appState.selectedEdgeId = null;
    
    const node = data._nodeById.get(nodeId);
    if (node && String(node.status).includes('CLIP_ROLLBACK_ATTEMPT')) {
        // rollback 节点：显示分叉详情 + IGV 按钮
        detailPanel.showClipNodeDetail(node);
    } else {
        // 稳定 round 节点：显示节点详情
        detailPanel.showRoundNodeDetail(node);
    }
}

// 边点击 → 显示边详情
function onEdgeClick(edgeId, data) {
    appState.selectedEdgeId = edgeId;
    appState.selectedNodeId = null;
    
    const edge = data._edgeById.get(edgeId);
    detailPanel.showEdgeDetail(edge);
}
```

### 5.6 detail-panel.js — 详情面板

#### 5.6.1 布局

```
+----------------------------------+
| 详情面板                    [✕]  |
+----------------------------------+
| 📄 描述                          |
| 稳定延申 round 节点。             |
+----------------------------------+
| 📊 基本信息                      |
| round_node    | round_05_1_1     |
| round         | 5                |
| path_id       | path_000008      |
| status        | ACTIVE           |
| ref_len       | 83812            |
| ...           | ...              |
+----------------------------------+
| 📋 候选分支 (candidates)         |
| candidate_id | mode   | status  |
| normal       | normal | BUILT   |
| site_0001    | clip   | BUILT   |
+----------------------------------+
| 🧬 IGV 操作                      |
| [在 IGV 中查看此节点 reads]      |
| [在 IGV 中查看完整路径]          |
+----------------------------------+
```

#### 5.6.2 实现细节

- CSS class `detail-panel` + `detail-panel.open` 控制滑入/滑出
- CSS `transform: translateX(100%)` → `translateX(0)` 动画
- 点击遮罩层或 ✕ 按钮关闭
- Escape 键关闭
- Candidate 表格数据来自 `node.candidates`（已有字段）

### 5.7 toolbar.js — 筛选与搜索

#### 5.7.1 Round 筛选

```html
<div class="toolbar">
    <div class="filter-group">
        <label>Round:</label>
        <select id="round-filter" multiple>
            <option value="0">Round 0</option>
            <option value="1">Round 1</option>
            ...
            <option value="37">Round 37</option>
        </select>
    </div>
```

实现：
- 多选下拉框，选中多个 round
- 未选中 round 的节点 → CSS `opacity: 0.08; pointer-events: none`
- 未选中 round 相关的边也淡化
- "全选 / 取消全选" 快捷按钮

#### 5.7.2 Path 筛选

```html
    <div class="filter-group">
        <label>Path:</label>
        <select id="path-filter">
            <option value="">全部路径</option>
            <option value="path_001">path_001 (STOP_LOW_NOCLIP, round 4)</option>
            <option value="path_014">path_014 (STOP_LOW_NOCLIP, round 23)</option>
            ...
        </select>
    </div>
```

实现：
- 单选下拉框，选中一条 path
- 高亮该 path 经过的所有节点（加粗边框+发光）
- 同时自动加载该 path 的 IGV 视图
- 其他节点淡化

#### 5.7.3 文本搜索

```html
    <div class="search-group">
        <input type="text" id="node-search" 
               placeholder="搜索节点 (round_05, path_000004...)">
        <div class="search-results"></div>
    </div>
```

实现：
- 输入文本实时搜索 `node.id`、`node.label`、`node.path_id`
- 匹配结果以下拉列表展示
- 点击结果 → 滚动并居中到该节点
- 匹配节点高亮闪烁动画

#### 5.7.4 导出按钮

```html
    <div class="export-group">
        <button id="btn-export-svg">导出 SVG</button>
        <button id="btn-export-png">导出 PNG</button>
    </div>
```

### 5.8 export.js — 导出

```javascript
function exportSVG() {
    const svg = document.querySelector('#tree-svg');
    const clone = svg.cloneNode(true);
    // 内联所有 CSS 样式
    const serializer = new XMLSerializer();
    const svgString = serializer.serializeToString(clone);
    const blob = new Blob([svgString], { type: 'image/svg+xml' });
    downloadBlob(blob, 'roundtree.svg');
}

function exportPNG() {
    const svg = document.querySelector('#tree-svg');
    const svgString = new XMLSerializer().serializeToString(svg);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    const img = new Image();
    img.onload = () => {
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        canvas.toBlob(blob => downloadBlob(blob, 'roundtree.png'));
    };
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgString)));
}
```

---

## 6. IGV 集成详细设计

### 6.1 igv-controller.js — 核心控制器

```javascript
class IgvController {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.browser = null;           // igv.Browser 实例（单例）
        this.currentView = null;       // { type: 'path' | 'clip', id: ... }
        this.visible = false;
    }
    
    async init() {
        // igv.js 通过 CDN 已加载到全局 igv 对象
        // 初始时不创建 Browser，等第一次需要时再创建（懒加载）
    }
    
    async showPathView(finalPathId, pathData) {
        this.visible = true;
        this.container.style.display = 'block';
        
        // 获取该 path 的最后一个 round（累积性 BAM）
        const lastRound = pathData.rounds[pathData.rounds.length - 1];
        
        const options = {
            genome: `mtDNA_${finalPathId}`,
            reference: {
                id: `mtDNA_${finalPathId}`,
                fastaURL: CONFIG.httpBase + '/' + lastRound.ref_fa_url,
                indexURL: CONFIG.httpBase + '/' + lastRound.ref_fa_url + '.fai',
            },
            tracks: [{
                name: `${finalPathId} - cumulative support reads`,
                url: CONFIG.httpBase + '/' + lastRound.bam_url,
                indexURL: CONFIG.httpBase + '/' + lastRound.bam_index_url,
                format: 'bam',
                type: 'alignment',
                height: 300,
                color: '#2563eb',
            }],
            showRuler: true,
        };
        
        // 复用或创建 browser
        if (this.browser) {
            await this.browser.loadGenome(options);
        } else {
            this.browser = await igv.createBrowser(this.container, options);
        }
        
        this.currentView = { type: 'path', id: finalPathId };
    }
    
    async showClipView(clipNodeId, clipNode, data) {
        this.visible = true;
        this.container.style.display = 'block';
        
        // 找父节点
        const parentEdges = data._edgesByTarget.get(clipNodeId) || [];
        const parentNode = data._nodeById.get(parentEdges[0]?.source);
        
        // 找子节点
        const childEdges = data._edgesBySource.get(clipNodeId) || [];
        
        const tracks = [];
        
        // Track 1: 父节点 path_support_reads（灰色）
        if (parentNode?.urls?.final_dir) {
            tracks.push({
                name: `Parent: ${parentNode.label}`,
                url: CONFIG.httpBase + '/' + parentNode.urls.final_dir + '/path_support_reads_vs_ref.bam',
                indexURL: CONFIG.httpBase + '/' + parentNode.urls.final_dir + '/path_support_reads_vs_ref.bam.bai',
                format: 'bam', type: 'alignment', height: 80,
                color: '#94a3b8',
            });
        }
        
        // Track 2: strict_reads（橙色，触发 clip 检测的 reads）
        const internalDir = clipNode.urls.round_dir;
        if (internalDir) {
            tracks.push({
                name: 'Strict reads (clip detection)',
                url: CONFIG.httpBase + '/' + internalDir + '/strict_reads_vs_ref.bam',
                indexURL: CONFIG.httpBase + '/' + internalDir + '/strict_reads_vs_ref.bam.bai',
                format: 'bam', type: 'alignment', height: 80,
                color: '#f08a24',
            });
        }
        
        // Track 3+: 各子分支 BAM
        for (const edge of childEdges) {
            const childNode = data._nodeById.get(edge.target);
            const edgeInfo = data.edge_info[edge.id];
            const color = edgeInfo?.branch_color || '#2563eb';
            if (childNode?.urls?.final_dir) {
                tracks.push({
                    name: `Branch: ${childNode.label}`,
                    url: CONFIG.httpBase + '/' + childNode.urls.final_dir + '/path_support_reads_vs_ref.bam',
                    indexURL: CONFIG.httpBase + '/' + childNode.urls.final_dir + '/path_support_reads_vs_ref.bam.bai',
                    format: 'bam', type: 'alignment', height: 80,
                    color: color,
                });
            }
        }
        
        const refUrl = parentNode?.urls?.ref_fa || clipNode.urls.ref_fa;
        const options = {
            genome: `mtDNA_clip_${clipNodeId}`,
            reference: {
                id: `mtDNA_clip_${clipNodeId}`,
                fastaURL: CONFIG.httpBase + '/' + refUrl,
                indexURL: CONFIG.httpBase + '/' + refUrl + '.fai',
            },
            tracks: tracks,
            showRuler: true,
        };
        
        if (this.browser) {
            await this.browser.loadGenome(options);
        } else {
            this.browser = await igv.createBrowser(this.container, options);
        }
        
        this.currentView = { type: 'clip', id: clipNodeId };
    }
    
    hide() {
        this.visible = false;
        this.container.style.display = 'none';
        if (this.browser) {
            // 不销毁 browser，保留实例以便下次快速恢复
        }
    }
    
    toggle() {
        this.visible ? this.hide() : this.show();
    }
}
```

### 6.2 Path IGV 视图的交互

当用户从 path 下拉框选择一条 path 时：
1. 树图中**高亮该 path 经过的所有 round 节点**（加粗边框 + 发光效果，其他节点淡化）
2. 自动加载 IGV 视图（该 path 最终 round 的累积 BAM，一条轨道覆盖全部 reads）
3. 36 条 path 对应 36 个选项，选哪个就高亮哪条 + 加载哪个的 BAM
4. 不需要显示多个 round 的轨道——最终 round 的 `path_support_reads_vs_ref.bam` 是累积性的，天然包含从 round_00 到最终 round 的所有 reads

### 6.3 Clip IGV 视图的交互

当用户点击 rollback 节点 → 详情面板出现 → 点击「在 IGV 中查看分叉点」：
1. IGV 加载父节点 ref + 多轨道 BAM
2. 轨道颜色与树图中的分支颜色一致
3. 用户可以直观看到在哪个位点 strict reads 和不同分支 reads 出现分歧

### 6.4 容错处理

| 错误场景 | 处理方式 |
|---------|---------|
| BAM 文件不存在 | 跳过该轨道，console.warn |
| BAM 索引缺失 | 跳过该轨道，显示警告 tooltip |
| HTTP 服务不可达 | IGV 面板显示「无法连接到文件服务，请运行 start.sh」 |
| igv.js CDN 加载失败 | IGV 面板显示「IGV 库加载失败，请检查网络」 |
| 浏览器不支持 | 检测 igv 全局对象，不支持时隐藏 IGV 面板 |

---

## 7. 样式方案

### 7.1 整体布局（CSS Grid）

```css
body {
    display: grid;
    grid-template-rows: auto 1fr auto auto;
    grid-template-columns: 1fr;
    height: 100vh;
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

#toolbar {
    grid-row: 1;
    /* 固定在顶部 */
}

#main-area {
    grid-row: 2;
    position: relative;
    overflow: hidden;
    /* 包含 SVG 容器和详情面板 */
}

#resizer {
    grid-row: 3;
    height: 6px;
    background: #e5e7eb;
    cursor: row-resize;
}

#igv-panel {
    grid-row: 4;
    height: 400px;
    border-top: 1px solid #e5e7eb;
}

#igv-panel.collapsed {
    height: 0;
    display: none;
}
```

### 7.2 树图 SVG 容器

```css
#tree-container {
    width: 100%;
    height: 100%;
    overflow: auto;
    background: #fafbfc;
}

#tree-svg {
    /* width/height 由 JS 动态设置以支持缩放 */
}

.node-label {
    font-size: 14px;
    fill: #374151;
    font-family: 'Consolas', 'Monaco', monospace;
    user-select: none;
}

.rollback-label {
    fill: #f08a24;
    font-weight: 600;
}

.link-same_path {
    /* 默认灰色实线 */
}

.link-rollback_attempt {
    stroke-dasharray: 10, 8;
    stroke: #f08a24;
}

.link-spawn {
    /* 颜色由 JS 动态设置 */
}
```

### 7.3 详情面板

```css
#detail-panel {
    position: absolute;
    right: 0;
    top: 0;
    width: 420px;
    height: 100%;
    background: #fff;
    box-shadow: -4px 0 16px rgba(0,0,0,0.1);
    transform: translateX(100%);
    transition: transform 0.3s ease;
    overflow-y: auto;
    z-index: 10;
}

#detail-panel.open {
    transform: translateX(0);
}
```

### 7.4 图例

```css
#legend {
    display: flex;
    gap: 16px;
    padding: 8px 16px;
    background: #f9fafb;
    border-bottom: 1px solid #e5e7eb;
}

.legend-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
}

.legend-dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
}
```

---

## 8. HTML 骨架

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>线粒体延申 Round Tree - Clip/Rollback 动态展示</title>
    <link rel="stylesheet" href="css/style.css">
    
    <!-- D3.js v7 -->
    <script src="https://d3js.org/d3.v7.min.js"></script>
    <!-- igv.js v3 -->
    <script src="https://cdn.jsdelivr.net/npm/igv@3.1.0/dist/igv.min.js"></script>
</head>
<body>
    <!-- 图例栏 -->
    <div id="legend">
        <span class="legend-item">
            <span class="legend-dot" style="background:#2563eb"></span> ACTIVE
        </span>
        <span class="legend-item">
            <span class="legend-dot" style="background:#f08a24; border:2px dashed #f08a24"></span> Clip/Rollback Attempt
        </span>
        <span class="legend-item">
            <span class="legend-dot" style="background:#dc2626"></span> STOP
        </span>
        <span class="legend-item">
            <span style="border-bottom:3px solid #aebbd1; width:20px"></span> 正常延申
        </span>
        <span class="legend-item">
            <span style="border-bottom:3px dashed #f08a24; width:20px"></span> Rollback
        </span>
        <span class="legend-item">
            <span style="border-bottom:3px solid #2563eb; width:20px"></span> 分支延申 (spawn)
        </span>
    </div>

    <!-- 工具栏 -->
    <div id="toolbar">
        <div class="toolbar-left">
            <select id="path-filter">
                <option value="">-- 全部路径 --</option>
            </select>
            <div class="round-filter">
                <button id="btn-rounds-all">全部 Round</button>
                <button id="btn-rounds-clear">清除</button>
                <div id="round-checkboxes"></div>
            </div>
            <input type="text" id="node-search" placeholder="搜索节点...">
        </div>
        <div class="toolbar-center">
            <button id="btn-zoom-in" title="放大">+</button>
            <button id="btn-zoom-out" title="缩小">−</button>
            <button id="btn-fit" title="适配视图">Fit</button>
            <button id="btn-reset" title="重置视图">Reset</button>
        </div>
        <div class="toolbar-right">
            <button id="btn-toggle-igv">IGV 面板</button>
            <button id="btn-export-svg">SVG</button>
            <button id="btn-export-png">PNG</button>
            <span id="info-bar"></span>
        </div>
    </div>

    <!-- 主区域：树图 + 详情面板 -->
    <div id="main-area">
        <div id="tree-container">
            <svg id="tree-svg">
                <defs>
                    <marker id="arrowhead" ...></marker>
                </defs>
                <g id="link-group"></g>
                <g id="node-group"></g>
            </svg>
        </div>
        <div id="detail-panel">
            <div id="detail-header">
                <h3 id="detail-title"></h3>
                <button id="detail-close">✕</button>
            </div>
            <div id="detail-content"></div>
        </div>
    </div>

    <!-- 拖拽分隔条 -->
    <div id="resizer"></div>

    <!-- IGV 面板 -->
    <div id="igv-panel" class="collapsed">
        <div id="igv-header">
            <span id="igv-title">IGV Viewer</span>
            <button id="igv-close">✕</button>
        </div>
        <div id="igv-container"></div>
    </div>

    <!-- JS 模块（按依赖顺序加载） -->
    <script src="js/config.js"></script>
    <script src="js/data-loader.js"></script>
    <script src="js/layout.js"></script>
    <script src="js/render.js"></script>
    <script src="js/interaction.js"></script>
    <script src="js/detail-panel.js"></script>
    <script src="js/toolbar.js"></script>
    <script src="js/igv-controller.js"></script>
    <script src="js/export.js"></script>
    <script src="js/app.js"></script>
    <script>
        // 启动应用
        document.addEventListener('DOMContentLoaded', () => {
            window.app = new App();
            window.app.init();
        });
    </script>
</body>
</html>
```

---

## 9. 技术栈选型

### 9.1 整体架构

```
┌─────────────────────────────────────────────┐
│  浏览器                                        │
│  ┌───────────────────────────────────────┐   │
│  │  index.html (Vanilla JS, 无框架)        │   │
│  │  ├── D3.js v7      树图 SVG 渲染       │   │
│  │  ├── igv.js v3.x   Reads 轨道浏览      │   │
│  │  └── 10 个 JS 模块  布局/交互/筛选/IGV  │   │
│  └───────────────────────────────────────┘   │
│                    ▲                          │
│                    │ HTTP (localhost:8765)     │
│  ┌───────────────────────────────────────┐   │
│  │  Python http.server                    │   │
│  │  ├── 静态文件 (HTML/CSS/JS)            │   │
│  │  ├── tree_data.json                   │   │
│  │  └── BAM / FASTA 文件                  │   │
│  └───────────────────────────────────────┘   │
│                    ▲                          │
│              generate_tree_data.py            │
│              (import 现有 collect_tree)        │
└─────────────────────────────────────────────┘
```

### 9.2 各层技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| **后端数据生成** | Python 3 | 仅用标准库（csv, json, pathlib, importlib），import 现有 `collect_tree()` 函数，生成 `tree_data.json` |
| **文件服务** | Python http.server | 标准库，零依赖，提供 HTTP 访问 BAM/FASTA 文件，原生支持 Range 请求 |
| **前端框架** | 无框架，Vanilla JS | 不依赖 React/Vue/Angular，纯原生 JavaScript，无构建步骤，浏览器直接运行 |
| **树图渲染** | D3.js v7 | 仅用于 SVG data join 和缩放/平移，布局算法自己写（不用 d3.tree()） |
| **基因组浏览** | igv.js v3.x | 嵌入页面底部，加载 BAM 轨道展示 reads 覆盖 |
| **样式** | 纯 CSS | CSS Grid 布局，无 CSS 框架 |

### 9.3 为什么是 Vanilla JS 而不是 React/Vue？

本工具的数据特征是：**一次性加载静态数据 → 渲染树图 → 用户交互浏览**。没有表单提交、没有实时数据更新、没有路由切换。

React/Vue 的核心价值在于处理**频繁更新的 UI**（如聊天消息流、股票行情实时刷新、协作文档多人编辑、仪表盘定时拉数据重绘等场景），通过虚拟 DOM diff 高效地只更新变化部分。

而本工具树图渲染完后只有 CSS class 切换（高亮/淡化/显示/隐藏），没有 DOM 结构的增删改。Vanilla JS + D3 完全够用，引入框架是多此一举。

### 9.4 后续做成独立软件

两种路径，都在当前架构上自然延伸：

| 方案 | 做法 | 用户体验 |
|------|------|---------|
| **轻量方案** | 目录打包 + `start.sh` → 用户浏览器打开 `localhost:8765` | 终端启动，浏览器使用 |
| **桌面方案** | 用 Electron 套壳，内嵌 Python 后端 + Chromium | 双击图标打开，像本地软件 |

两种方案都不需要改动前端代码，因为前端始终是静态 HTML/JS。

---

## 10. 已确认决策

| # | 问题 | 决策 |
|---|------|------|
| 1 | **项目部署位置** | `/share/home/yding25/mtDNA/MH63_auto/roundtree_frontend/`，HTTP 服务根为 `/share/home/yding25/mtDNA/` |
| 2 | **BAM 跨参考序列** | 方案 A：只加载最终 round 的累积性 `path_support_reads_vs_ref.bam`，天然包含所有历史 reads |
| 3 | **igv.js CDN** | 先尝试使用 CDN（`cdn.jsdelivr.net`），如果不能访问再下载到本地 |
| 4 | **多用户支持** | 当前单用户本地使用。后续做成独立软件时再考虑 |
| 5 | **Path IGV 展示** | 只加载 36 条最终 path 各自对应的最终累积 BAM。选中 path 时同时高亮该 path 经过的所有 round 节点 |
| 6 | **rollback 节点形状** | 圆形，与现有实现一致，后续可切换为菱形 |

---

## 11. 实现顺序

| 步骤 | 文件 | 说明 |
|------|------|------|
| 1 | `generate_tree_data.py` | 后端数据生成 |
| 2 | `start.sh` | 一键启动脚本 |
| 3 | `index.html` + `css/style.css` | 页面骨架 |
| 4 | `js/config.js` + `js/data-loader.js` | 配置 + 数据加载 |
| 5 | `js/layout.js` | 布局算法 |
| 6 | `js/render.js` | D3 渲染（节点、边、标签） |
| 7 | `js/interaction.js` | 缩放/平移/点击 |
| 8 | `js/detail-panel.js` | 详情面板（第 5.6.1 节布局） |
| 9 | `js/toolbar.js` | 筛选/搜索/导出 |
| 10 | `js/export.js` | SVG/PNG 导出 |
| 11 | `js/igv-controller.js` | IGV 控制器（path + clip 视图） |
| 12 | `js/app.js` | 总装 + 事件总线 |
| 13 | 联调测试 | 端到端验证 |
