import { FolderPlus, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  ES_CLAUSES,
  ES_OPERATORS,
  addChild,
  esOperatorInfo,
  newCond,
  newGroup,
  removeNode,
  updateNode,
  type EsClause,
  type EsCondNode,
  type EsGroupNode,
  type EsNode,
  type EsOperatorInfo,
  type EsSortField,
} from "@/lib/esQuery";

const FIELD_DATALIST = "es-field-list";

function valuePlaceholder(info: EsOperatorInfo): string {
  if (info.input === "range") return '{"gte": 18, "lt": 60}';
  if (info.value === "wildcard") return "*abc*";
  return "值（数字 / 字符串 / JSON）";
}

interface Props {
  root: EsNode;
  onChange: (n: EsNode) => void;
  sorts: EsSortField[];
  onSortsChange: (s: EsSortField[]) => void;
  size: string;
  onSizeChange: (v: string) => void;
  from: string;
  onFromChange: (v: string) => void;
  fields: string[];
}

export function EsQueryBuilder({
  root,
  onChange,
  sorts,
  onSortsChange,
  size,
  onSizeChange,
  from,
  onFromChange,
  fields,
}: Props) {
  if (root.kind !== "group") return null;

  const addCondition = (parentId: string) => onChange(addChild(root, parentId, newCond()));
  const addGroup = (parentId: string, clause: EsClause) =>
    onChange(addChild(root, parentId, newGroup(clause)));
  const remove = (id: string) => onChange(removeNode(root, id));
  const patch = (id: string, p: Record<string, unknown>) => onChange(updateNode(root, id, p));

  return (
    <div className="space-y-2.5">
      <datalist id={FIELD_DATALIST}>
        {fields.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>

      <GroupView
        group={root}
        isRoot
        onAddCondition={addCondition}
        onAddGroup={addGroup}
        onRemove={remove}
        onPatch={patch}
      />

      {/* 排序 */}
      <div className="rounded-md border">
        <div className="flex h-8 items-center gap-2 border-b px-2.5 text-xs">
          <span className="font-medium">排序</span>
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            onClick={() => onSortsChange([...sorts, { field: "", dir: "desc" }])}
          >
            <Plus className="size-3" /> 加一条
          </Button>
        </div>
        {sorts.length === 0 ? (
          <div className="px-2.5 py-1.5 text-xs text-muted-foreground">未设置排序</div>
        ) : (
          <div className="space-y-1.5 p-1.5">
            {sorts.map((s, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <Input
                  list={FIELD_DATALIST}
                  value={s.field}
                  onChange={(e) => {
                    const next = sorts.slice();
                    next[i] = { ...next[i], field: e.target.value };
                    onSortsChange(next);
                  }}
                  placeholder="字段"
                  className="h-7 min-w-0 flex-1 font-mono text-xs"
                />
                <Select
                  value={s.dir}
                  onValueChange={(v) => {
                    const next = sorts.slice();
                    next[i] = { ...next[i], dir: v === "asc" ? "asc" : "desc" };
                    onSortsChange(next);
                  }}
                >
                  <SelectTrigger className="h-7 w-24 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="desc">降序 desc</SelectItem>
                    <SelectItem value="asc">升序 asc</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => onSortsChange(sorts.filter((_, j) => j !== i))}
                >
                  <Trash2 className="size-3" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 条数 */}
      <div className="flex flex-wrap items-center gap-4 rounded-md border px-2.5 py-2 text-xs">
        <label className="flex items-center gap-1.5">
          返回条数
          <Input
            value={size}
            onChange={(e) => onSizeChange(e.target.value)}
            className="h-7 w-20 font-mono text-xs"
            placeholder="20"
          />
        </label>
        <label className="flex items-center gap-1.5">
          跳过
          <Input
            value={from}
            onChange={(e) => onFromChange(e.target.value)}
            className="h-7 w-20 font-mono text-xs"
            placeholder="0"
          />
        </label>
      </div>
    </div>
  );
}

interface GroupProps {
  group: EsGroupNode;
  isRoot?: boolean;
  onAddCondition: (id: string) => void;
  onAddGroup: (id: string, clause: EsClause) => void;
  onRemove: (id: string) => void;
  onPatch: (id: string, patch: Record<string, unknown>) => void;
}

function GroupView({ group, isRoot, onAddCondition, onAddGroup, onRemove, onPatch }: GroupProps) {
  return (
    <div className={cn("rounded-md border", !isRoot && "border-dashed bg-muted/30")}>
      <div className="flex flex-wrap items-center gap-1.5 border-b px-2 py-1.5">
        <Select
          value={group.clause}
          onValueChange={(v) => onPatch(group.id, { clause: v })}
        >
          <SelectTrigger className="h-6 w-32 shrink-0 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ES_CLAUSES.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="xs" variant="ghost" onClick={() => onAddCondition(group.id)}>
          <Plus className="size-3" /> 条件
        </Button>
        <Button size="xs" variant="ghost" onClick={() => onAddGroup(group.id, "should")}>
          <FolderPlus className="size-3" /> 分组
        </Button>
        {!isRoot && (
          <Button
            size="icon-xs"
            variant="ghost"
            className="ml-auto text-muted-foreground hover:text-destructive"
            onClick={() => onRemove(group.id)}
          >
            <Trash2 className="size-3" />
          </Button>
        )}
      </div>
      <div className="space-y-1.5 p-2">
        {group.children.length === 0 && (
          <div className="text-xs text-muted-foreground">空分组，点「条件」加一条</div>
        )}
        {group.children.map((child) =>
          child.kind === "cond" ? (
            <CondView key={child.id} node={child} onRemove={onRemove} onPatch={onPatch} />
          ) : (
            <GroupView
              key={child.id}
              group={child}
              onAddCondition={onAddCondition}
              onAddGroup={onAddGroup}
              onRemove={onRemove}
              onPatch={onPatch}
            />
          ),
        )}
      </div>
    </div>
  );
}

interface CondProps {
  node: EsCondNode;
  onRemove: (id: string) => void;
  onPatch: (id: string, patch: Record<string, unknown>) => void;
}

function CondView({ node, onRemove, onPatch }: CondProps) {
  const info = esOperatorInfo(node.op);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Input
        list={FIELD_DATALIST}
        value={node.field}
        onChange={(e) => onPatch(node.id, { field: e.target.value })}
        placeholder="字段"
        className="h-7 w-44 shrink-0 font-mono text-xs"
      />
      <Select value={node.op} onValueChange={(v) => onPatch(node.id, { op: v })}>
        <SelectTrigger className="h-7 w-40 shrink-0 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ES_OPERATORS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {info.input === "bool" ? (
        <div className="min-w-0 flex-1 text-xs text-muted-foreground">（只判断字段是否存在）</div>
      ) : (
        <Input
          value={node.value}
          onChange={(e) => onPatch(node.id, { value: e.target.value })}
          placeholder={valuePlaceholder(info)}
          className="h-7 min-w-32 flex-1 font-mono text-xs"
        />
      )}
      <Button
        size="icon-xs"
        variant="ghost"
        className="text-muted-foreground hover:text-destructive"
        onClick={() => onRemove(node.id)}
      >
        <Trash2 className="size-3" />
      </Button>
    </div>
  );
}
