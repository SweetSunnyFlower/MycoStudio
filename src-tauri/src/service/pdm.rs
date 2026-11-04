//! PowerDesigner `.pdm`（物理数据模型）解析。
//!
//! `.pdm` 从 PowerDesigner 7 起就是 XML：`o:RootObject → c:Children → o:Model`，
//! 表在 `c:Tables/o:Table` 下，字段在 `c:Columns`，主键在 `c:PrimaryKey/o:Key`，
//! 索引在 `c:Indexes`，外键（PowerDesigner 叫 Reference）在 `c:References`。
//!
//! 不同 PowerDesigner 版本（9/11/12/15/16/16.5）的**前缀不完全一样**
//! （有的只有 `o:` / `a:`，有的还有 `c:`），所以这里一律按「去掉前缀的本地名」匹配，
//! 同时靠「有没有子节点」区分「定义」和「引用」：
//! `<o:Table Ref="o3"/>`（引用） vs `<o:Table><a:Code>…</a:Code></o:Table>`（定义）。

use std::collections::HashMap;
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::{Reader, XmlVersion};
use serde::{Deserialize, Serialize};

use crate::domain::{GraphColumn, GraphEdge, GraphIndex, GraphTable, SchemaGraph};
use crate::error::{AppError, AppResult};

/// 一个打开的 PDM 文件
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdmFile {
    pub path: String,
    pub file_name: String,
    /// 模型名（`o:Model/a:Name`）
    pub model_name: String,
    pub graph: SchemaGraph,
}

#[derive(Debug, Clone, Default)]
struct Node {
    name: String,
    attrs: Vec<(String, String)>,
    text: String,
    children: Vec<Node>,
}

impl Node {
    fn attr(&self, key: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }
    fn child(&self, name: &str) -> Option<&Node> {
        self.children.iter().find(|c| c.name == name)
    }
    fn kids(&self, name: &str) -> impl Iterator<Item = &Node> {
        self.children.iter().filter(move |c| c.name == name)
    }
    /// 取子节点里的文本（`a:Code` / `a:Name` / `a:Comment` …），顺带 unescape
    fn text_of(&self, name: &str) -> Option<String> {
        let t = self.child(name)?.text.trim();
        if t.is_empty() {
            None
        } else {
            Some(unescape(t))
        }
    }
    /// 先序遍历找所有同名后代
    fn find_all<'a>(&'a self, name: &str, out: &mut Vec<&'a Node>) {
        for c in &self.children {
            if c.name == name {
                out.push(c);
            }
            c.find_all(name, out);
        }
    }
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn parse_xml(xml: &str) -> AppResult<Node> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut stack: Vec<Node> = vec![Node { name: "#document".to_string(), ..Default::default() }];
    loop {
        let event = reader
            .read_event()
            .map_err(|e| AppError::Message(format!("解析 PDM 失败：{e}")))?;
        match event {
            Event::Start(e) => {
                let node = Node {
                    name: e.local_name().as_ref().to_string(),
                    attrs: read_attrs(&e),
                    ..Default::default()
                };
                stack.push(node);
            }
            Event::Empty(e) => {
                let node = Node {
                    name: e.local_name().as_ref().to_string(),
                    attrs: read_attrs(&e),
                    ..Default::default()
                };
                if let Some(parent) = stack.last_mut() {
                    parent.children.push(node);
                }
            }
            Event::End(_) => {
                if stack.len() > 1 {
                    let node = stack.pop().unwrap();
                    if let Some(parent) = stack.last_mut() {
                        parent.children.push(node);
                    }
                }
            }
            Event::Text(t) => {
                if let Some(top) = stack.last_mut() {
                    top.text.push_str(&t.xml_content(XmlVersion::Explicit1_0));
                }
            }
            // `&amp;` 这类实体在 0.42 里是单独的事件，要自己还原
            Event::GeneralRef(r) => {
                if let Some(top) = stack.last_mut() {
                    let name = r.into_inner();
                    let resolved = match name.as_ref() {
                        "amp" => "&",
                        "lt" => "<",
                        "gt" => ">",
                        "quot" => "\"",
                        "apos" => "'",
                        other => other,
                    };
                    top.text.push_str(resolved);
                }
            }
            Event::CData(t) => {
                if let Some(top) = stack.last_mut() {
                    top.text.push_str(t.as_ref());
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(stack.pop().unwrap_or_default())
}

fn read_attrs(e: &quick_xml::events::BytesStart<'_>) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for attr in e.attributes().flatten() {
        let key = attr.key.local_name().as_ref().to_string();
        // 属性值在 quick-xml 0.42 里已经是 UTF-8 字符串，`normalized_value` 只做转义还原
        let value = attr
            .normalized_value(XmlVersion::Implicit1_0)
            .map(|v| v.to_string())
            .unwrap_or_else(|_| attr.value.to_string());
        out.push((key, value));
    }
    out
}

/// 表/字段的「标识」：优先 `a:Code`，没有就用 `a:Name`
fn code_of(node: &Node) -> String {
    node.text_of("Code").or_else(|| node.text_of("Name")).unwrap_or_default()
}

/// 拼出可读类型：`varchar` + Length(50) → `varchar(50)`；精度/标度同理
fn compose_type(node: &Node) -> String {
    let base = node.text_of("DataType").unwrap_or_default();
    if base.is_empty() {
        return String::new();
    }
    if base.contains('(') {
        return base;
    }
    let length = node.text_of("Length").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
    let precision = node.text_of("Precision").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
    let scale = node.text_of("Scale").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
    if precision > 0 {
        return format!("{base}({precision},{scale})");
    }
    let lower = base.to_ascii_lowercase();
    // 这些类型不带长度：date / timestamp / text / blob / bool …
    let no_length = [
        "date", "time", "datetime", "timestamp", "text", "longtext", "mediumtext", "tinytext",
        "blob", "longblob", "mediumblob", "tinyblob", "clob", "nclob", "bool", "boolean", "real",
        "float", "double", "uuid", "json", "xml", "uniqueidentifier",
    ];
    let sized = !no_length.iter().any(|t| lower == *t || lower.starts_with(&format!("{t} ")));
    if length > 0 && sized {
        return format!("{base}({length})");
    }
    base
}

/// 解析一个 `.pdm` 文件
pub fn read_pdm(path: &Path) -> AppResult<PdmFile> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| AppError::Message(format!("读取 PDM 文件失败：{e}")))?;
    let xml = raw.trim_start_matches('\u{feff}');
    let root = parse_xml(xml)?;

    let mut models = Vec::new();
    root.find_all("Model", &mut models);
    let model = models
        .first()
        .ok_or_else(|| AppError::Message("没找到 PDM 模型（o:Model）；确认这是 PowerDesigner 导出的 .pdm 文件".to_string()))?;
    let model_name = model.text_of("Name").unwrap_or_else(|| "PhysicalDataModel".to_string());

    // 表（定义）与字段（定义）先建档，拿到 Id → 名字的映射，后面解析引用要用
    let mut tables: Vec<GraphTable> = Vec::new();
    let mut table_index: HashMap<String, usize> = HashMap::new(); // Table Id → 下标
    let mut column_owner: HashMap<String, (usize, usize)> = HashMap::new(); // Column Id → (表下标, 列下标)

    let mut table_nodes: Vec<&Node> = Vec::new();
    model.find_all("Table", &mut table_nodes);
    for t in table_nodes {
        // 只认有 Columns 的定义节点，`<o:Table Ref="…"/>` 是引用
        let Some(columns_node) = t.child("Columns") else { continue };
        let name = code_of(t);
        if name.is_empty() {
            continue;
        }
        let mut columns: Vec<GraphColumn> = Vec::new();
        let mut index = Vec::new();
        for c in columns_node.kids("Column") {
            if c.attr("Ref").is_some() {
                continue;
            }
            let col_name = code_of(c);
            if col_name.is_empty() {
                continue;
            }
            index.push((c.attr("Id").unwrap_or_default().to_string(), columns.len()));
            columns.push(GraphColumn {
                name: col_name,
                raw_type: compose_type(c),
                nullable: c.text_of("Mandatory").as_deref() != Some("1"),
                primary_key: false,
                foreign_key: false,
                comment: c.text_of("Comment").unwrap_or_default(),
                // PowerDesigner：Name 是逻辑名（中文名一般写这儿），Code 才是物理列名
                logical_name: c
                    .text_of("Name")
                    .filter(|n| n != &code_of(c))
                    .unwrap_or_default(),
            });
        }
        let table_idx = tables.len();
        if let Some(id) = t.attr("Id") {
            table_index.insert(id.to_string(), table_idx);
        }
        for (col_id, col_idx) in index {
            if !col_id.is_empty() {
                column_owner.insert(col_id, (table_idx, col_idx));
            }
        }
        tables.push(GraphTable {
            name,
            columns,
            comment: t.text_of("Comment").unwrap_or_default(),
            logical_name: t.text_of("Name").filter(|n| n != &code_of(t)).unwrap_or_default(),
            indexes: Vec::new(),
        });
    }

    // 主键 + 索引 + 外键：都靠 Id 引用回表/字段
    for t in model.find_all_ref("Table") {
        let Some(columns_node) = t.child("Columns") else { continue };
        let _ = columns_node;
        let Some(&table_idx) = t.attr("Id").and_then(|id| table_index.get(id)) else { continue };

        // 主键：c:PrimaryKey/o:Key/c:Key.Columns/o:Column Ref
        if let Some(key) = t.child("PrimaryKey").and_then(|pk| pk.child("Key")) {
            let mut has_pk = false;
            if let Some(kc) = key.child("Key.Columns") {
                for c in kc.kids("Column") {
                    if let Some(id) = c.attr("Ref") {
                        if let Some(&(_, col_idx)) = column_owner.get(id) {
                            tables[table_idx].columns[col_idx].primary_key = true;
                            tables[table_idx].columns[col_idx].nullable = false;
                            has_pk = true;
                        }
                    }
                }
            }
            let name = key.text_of("ConstraintName").or_else(|| key.text_of("Code")).unwrap_or_default();
            let cols: Vec<String> = tables[table_idx]
                .columns
                .iter()
                .filter(|c| c.primary_key)
                .map(|c| c.name.clone())
                .collect();
            if has_pk && !cols.is_empty() {
                tables[table_idx].indexes.push(GraphIndex {
                    name: if name.is_empty() { "PRIMARY".to_string() } else { name },
                    columns: cols,
                    unique: true,
                    primary: true,
                });
            }
        }

        // 普通索引：c:Indexes/o:Index/a:Unique + c:IndexColumns/o:IndexColumn/c:Column/o:Column Ref
        if let Some(indexes) = t.child("Indexes") {
            for ix in indexes.kids("Index") {
                let name = ix.text_of("Code").or_else(|| ix.text_of("Name")).unwrap_or_default();
                let mut cols = Vec::new();
                if let Some(ixc) = ix.child("IndexColumns") {
                    for item in ixc.kids("IndexColumn") {
                        if let Some(col) = item.child("Column").and_then(|c| c.child("Column")) {
                            if let Some(id) = col.attr("Ref") {
                                if let Some(&(tbl, ci)) = column_owner.get(id) {
                                    cols.push(tables[tbl].columns[ci].name.clone());
                                }
                            }
                        }
                    }
                }
                if !cols.is_empty() {
                    tables[table_idx].indexes.push(GraphIndex {
                        name: if name.is_empty() { format!("IDX_{}", cols.join("_")) } else { name },
                        columns: cols,
                        unique: ix.text_of("Unique").as_deref() == Some("1"),
                        primary: false,
                    });
                }
            }
        }
    }

    // 外键（Reference）：ParentTable / ChildTable + Joins
    let mut edges: Vec<GraphEdge> = Vec::new();
    for r in model.find_all_ref("Reference") {
        let parent_id = r.child("ParentTable").and_then(|p| p.child("Table")).and_then(|t| t.attr("Ref"));
        let child_id = r.child("ChildTable").and_then(|p| p.child("Table")).and_then(|t| t.attr("Ref"));
        let (Some(parent_id), Some(child_id)) = (parent_id, child_id) else { continue };
        let (Some(&parent_idx), Some(&child_idx)) =
            (table_index.get(parent_id), table_index.get(child_id))
        else {
            continue;
        };
        let name = r.text_of("Code").or_else(|| r.text_of("Name")).unwrap_or_default();
        if let Some(joins) = r.child("Joins") {
            for join in joins.kids("ReferenceJoin") {
                let obj = |key: &str| -> Option<String> {
                    join.child(key).and_then(|o| o.child("Column")).and_then(|c| c.attr("Ref")).map(str::to_string)
                };
                let (Some(a), Some(b)) = (obj("Object1"), obj("Object2")) else { continue };
                let (Some(&(a_tbl, a_col)), Some(&(b_tbl, b_col))) =
                    (column_owner.get(&a), column_owner.get(&b))
                else {
                    continue;
                };
                // Object1 / Object2 到底哪个是父侧，各家 PDM 写法不完全一致：
                // 靠「谁在 ChildTable 上」来判定，保证箭头方向始终是 子 → 父
                let (parent_col, child_col) = if a_tbl == child_idx {
                    (b_col, a_col)
                } else if b_tbl == child_idx {
                    (a_col, b_col)
                } else {
                    let _ = parent_idx;
                    continue;
                };
                let parent_name = tables[parent_idx].columns.get(parent_col).map(|c| c.name.clone());
                let child_name = tables[child_idx].columns.get(child_col).map(|c| c.name.clone());
                let (Some(parent_column), Some(child_column)) = (parent_name, child_name) else {
                    continue;
                };
                tables[child_idx].columns[child_col].foreign_key = true;
                edges.push(GraphEdge {
                    from_table: tables[child_idx].name.clone(),
                    from_column: child_column,
                    to_table: tables[parent_idx].name.clone(),
                    to_column: parent_column,
                    name: name.clone(),
                });
            }
        }
    }

    // 同一对列可能被多条 Reference 重复连（PowerDesigner 里偶见），去重
    edges.sort_by(|a, b| {
        (&a.from_table, &a.from_column, &a.to_table, &a.to_column)
            .cmp(&(&b.from_table, &b.from_column, &b.to_table, &b.to_column))
    });
    edges.dedup_by(|a, b| {
        a.from_table == b.from_table
            && a.from_column == b.from_column
            && a.to_table == b.to_table
            && a.to_column == b.to_column
    });

    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "model.pdm".to_string());
    Ok(PdmFile {
        path: path.to_string_lossy().to_string(),
        file_name,
        model_name,
        graph: SchemaGraph { tables, edges },
    })
}

impl Node {
    fn find_all_ref(&self, name: &str) -> Vec<&Node> {
        let mut out = Vec::new();
        self.find_all(name, &mut out);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一份典型的 PowerDesigner 16 输出（缩略版）
    const SAMPLE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<o:RootObject Id="o1">
  <c:Children>
    <o:Model Id="o2">
      <a:Name>demo</a:Name>
      <a:Code>demo</a:Code>
      <c:Tables>
        <o:Table Id="o10">
          <a:Name>t_user</a:Name>
          <a:Code>t_user</a:Code>
          <a:Comment>用户表</a:Comment>
          <c:Columns>
            <o:Column Id="o11">
              <a:Name>id</a:Name>
              <a:Code>id</a:Code>
              <a:DataType>int</a:DataType>
              <a:Length>11</a:Length>
              <a:Mandatory>1</a:Mandatory>
            </o:Column>
            <o:Column Id="o12">
              <a:Name>登录名</a:Name>
              <a:Code>name</a:Code>
              <a:DataType>varchar</a:DataType>
              <a:Length>64</a:Length>
              <a:Comment>登录名 &amp; 昵称</a:Comment>
            </o:Column>
          </c:Columns>
          <c:PrimaryKey>
            <o:Key Id="o13">
              <a:Code>PK_T_USER</a:Code>
              <c:Key.Columns>
                <o:Column Ref="o11"/>
              </c:Key.Columns>
            </o:Key>
          </c:PrimaryKey>
          <c:Indexes>
            <o:Index Id="o14">
              <a:Code>IDX_USER_NAME</a:Code>
              <a:Unique>1</a:Unique>
              <c:IndexColumns>
                <o:IndexColumn>
                  <c:Column>
                    <o:Column Ref="o12"/>
                  </c:Column>
                </o:IndexColumn>
              </c:IndexColumns>
            </o:Index>
          </c:Indexes>
        </o:Table>
        <o:Table Id="o20">
          <a:Name>订单主表</a:Name>
          <a:Code>t_order</a:Code>
          <c:Columns>
            <o:Column Id="o21">
              <a:Name>id</a:Name>
              <a:Code>id</a:Code>
              <a:DataType>int</a:DataType>
              <a:Length>11</a:Length>
              <a:Mandatory>1</a:Mandatory>
            </o:Column>
            <o:Column Id="o22">
              <a:Name>user_id</a:Name>
              <a:Code>user_id</a:Code>
              <a:DataType>int</a:DataType>
              <a:Length>11</a:Length>
            </o:Column>
          </c:Columns>
          <c:PrimaryKey>
            <o:Key Id="o23">
              <c:Key.Columns>
                <o:Column Ref="o21"/>
              </c:Key.Columns>
            </o:Key>
          </c:PrimaryKey>
        </o:Table>
      </c:Tables>
      <c:References>
        <o:Reference Id="o30">
          <a:Code>FK_ORDER_USER</a:Code>
          <c:ParentTable>
            <o:Table Ref="o10"/>
          </c:ParentTable>
          <c:ChildTable>
            <o:Table Ref="o20"/>
          </c:ChildTable>
          <c:Joins>
            <o:ReferenceJoin>
              <c:Object1>
                <o:Column Ref="o11"/>
              </c:Object1>
              <c:Object2>
                <o:Column Ref="o22"/>
              </c:Object2>
            </o:ReferenceJoin>
          </c:Joins>
        </o:Reference>
      </c:References>
    </o:Model>
  </c:Children>
</o:RootObject>
"#;

    fn write_sample(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("myco-pdm-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("demo.pdm");
        std::fs::write(&path, SAMPLE).unwrap();
        path
    }

    #[test]
    fn parses_tables_columns_keys_indexes_and_references() {
        let file = read_pdm(&write_sample("basic")).unwrap();
        assert_eq!(file.file_name, "demo.pdm");
        assert_eq!(file.model_name, "demo");
        assert_eq!(file.graph.tables.len(), 2);

        let user = file.graph.tables.iter().find(|t| t.name == "t_user").unwrap();
        assert_eq!(user.comment, "用户表");
        assert_eq!(user.columns.len(), 2);
        let id = user.columns.iter().find(|c| c.name == "id").unwrap();
        assert_eq!(id.raw_type, "int(11)");
        assert!(id.primary_key);
        assert!(!id.nullable);
        let name = user.columns.iter().find(|c| c.name == "name").unwrap();
        assert_eq!(name.raw_type, "varchar(64)");
        assert_eq!(name.comment, "登录名 & 昵称");

        // PowerDesigner 的 Name（逻辑名）要单独保留：中文团队一般把中文名写这儿
        assert_eq!(name.logical_name, "登录名");
        assert_eq!(name.name, "name", "物理名仍然取 Code");
        let order = file.graph.tables.iter().find(|t| t.name == "t_order").unwrap();
        assert_eq!(order.logical_name, "订单主表", "表的逻辑名没读出来");
        // 表注释也要带出来
        assert_eq!(user.comment, "用户表");
        // 主键 + 唯一索引都在
        assert!(user.indexes.iter().any(|i| i.primary && i.columns == vec!["id".to_string()]));
        let idx = user.indexes.iter().find(|i| i.name == "IDX_USER_NAME").unwrap();
        assert!(idx.unique);
        assert_eq!(idx.columns, vec!["name".to_string()]);

        // 外键：t_order.user_id → t_user.id，方向是子→父
        assert_eq!(file.graph.edges.len(), 1);
        let edge = &file.graph.edges[0];
        assert_eq!(edge.from_table, "t_order");
        assert_eq!(edge.from_column, "user_id");
        assert_eq!(edge.to_table, "t_user");
        assert_eq!(edge.to_column, "id");
        assert_eq!(edge.name, "FK_ORDER_USER");
        let order = file.graph.tables.iter().find(|t| t.name == "t_order").unwrap();
        assert!(order.columns.iter().any(|c| c.name == "user_id" && c.foreign_key));
    }

    #[test]
    fn rejects_a_file_without_a_model() {
        let dir = std::env::temp_dir().join(format!("myco-pdm-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bad.pdm");
        std::fs::write(&path, "<html><body>nope</body></html>").unwrap();
        let err = read_pdm(&path).unwrap_err().to_string();
        assert!(err.contains("没找到 PDM 模型"), "{err}");
    }

    /// 回环验证：本应用「导出 PDM」生成的文件，自己还能读回来。
    /// `MYCO_PDM_TEST=/tmp/generated.pdm cargo test --lib -- --ignored parses_exported_pdm`
    #[test]
    #[ignore = "需要 MYCO_PDM_TEST 指向导出的 .pdm"]
    fn parses_exported_pdm() {
        let path = std::env::var("MYCO_PDM_TEST").expect("需要设置 MYCO_PDM_TEST");
        let file = read_pdm(std::path::Path::new(&path)).expect("解析导出的 PDM 失败");
        println!(
            "模型 {}：{} 张表 / {} 条外键",
            file.model_name,
            file.graph.tables.len(),
            file.graph.edges.len()
        );
        assert!(!file.graph.tables.is_empty(), "导出的 PDM 里没有表");
        assert!(file.graph.edges.len() > 0, "外键没被写进去");
        for t in &file.graph.tables {
            assert!(!t.columns.is_empty(), "{} 没有字段", t.name);
        }
        let indexes: usize = file.graph.tables.iter().map(|t| t.indexes.len()).sum();
        assert!(indexes > 0, "索引没被写进去");
        let pk_tables = file.graph.tables.iter().filter(|t| t.columns.iter().any(|c| c.primary_key)).count();
        assert!(pk_tables > 0, "主键没被写进去");
        let fk_cols = file
            .graph
            .tables
            .iter()
            .flat_map(|t| t.columns.iter())
            .filter(|c| c.foreign_key)
            .count();
        assert!(fk_cols > 0, "外键列没被标回来");
    }
}
