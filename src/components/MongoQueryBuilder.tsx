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
  MONGO_OPERATORS,
  addChild,
  newCond,
  newGroup,
  operatorInfo,
  removeNode,
  updateNode,
  type MongoCondNode,
  type MongoGroupNode,
  type MongoNode,
  type MongoSortField,
  type OperatorInfo,
} from "@/lib/mongoQuery";

const FIELD_DATALIST = "mongo-field-list";

function valuePlaceholder(info: OperatorInfo): string {
  if (info.input === "array") return "[1, 2, 3]";
  if (info.input === "number") return "10";
  if (info.value === "$regex") return "^abc";
  return "数字 / 字符串 / JSON";
}

interface Props {
  root: MongoNode;
  onChange: (n: MongoNode) => void;
  sorts: MongoSortField[];
  onSortsChange: (s: MongoSortField[]) => void;
  limit: string;
  onLimitChange: (v: string) => void;
  skip: string;
  onSkipChange: (v: string) => void;
  /** 当前集合里出现过的字段名，给字段输入做提示 */
  fields: string[];
}

export function MongoQueryBuilder({
  root,
  onChange,
  sorts,
  onSortsChange,
  limit,
  onLimitChange,
  skip,
  onSkipChange,
  fields,
}: Props) {
  if (root.kind !== "group") return null;

  const addCondition = (parentId: string) => onChange(addChild(root, parentId, newCond()));
  const addGroup = (parentId: string) => onChange(addChild(root, parentId, newGroup("or")));
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
            onClick={() => onSortsChange([...sorts, { field: "", dir: -1 }])}
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
                  value={String(s.dir)}
                  onValueChange={(v) => {
                    const next = sorts.slice();
                    next[i] = { ...next[i], dir: v === "1" ? 1 : -1 };
                    onSortsChange(next);
                  }}
                >
                  <SelectTrigger className="h-7 w-24 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="-1">降序 -1</SelectItem>
                    <SelectItem value="1">升序 1</SelectItem>
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
          限制条数
          <Input
            value={limit}
            onChange={(e) => onLimitChange(e.target.value)}
            className="h-7 w-20 font-mono text-xs"
            placeholder="200"
          />
        </label>
        <label className="flex items-center gap-1.5">
          跳过
          <Input
            value={skip}
            onChange={(e) => onSkipChange(e.target.value)}
            className="h-7 w-20 font-mono text-xs"
            placeholder="0"
          />
        </label>
      </div>
    </div>
  );
}

interface GroupProps {
  group: MongoGroupNode;
  isRoot?: boolean;
  onAddCondition: (id: string) => void;
  onAddGroup: (id: string) => void;
  onRemove: (id: string) => void;
  onPatch: (id: string, patch: Record<string, unknown>) => void;
}

function GroupView({ group, isRoot, onAddCondition, onAddGroup, onRemove, onPatch }: GroupProps) {
  return (
    <div className={cn("rounded-md border", !isRoot && "border-dashed bg-muted/30")}>
      <div className="flex flex-wrap items-center gap-1.5 border-b px-2 py-1.5">
        <div className="flex items-center rounded-md border bg-background p-0.5">
          {(["and", "or"] as const).map((logic) => (
            <button
              key={logic}
              type="button"
              onClick={() => onPatch(group.id, { logic })}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] font-medium transition",
                group.logic === logic
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {logic === "and" ? "且 AND" : "或 OR"}
            </button>
          ))}
        </div>
        <Button size="xs" variant="ghost" onClick={() => onAddCondition(group.id)}>
          <Plus className="size-3" /> 条件
        </Button>
        <Button size="xs" variant="ghost" onClick={() => onAddGroup(group.id)}>
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
            <CondView
              key={child.id}
              node={child}
              onRemove={onRemove}
              onPatch={onPatch}
            />
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
  node: MongoCondNode;
  onRemove: (id: string) => void;
  onPatch: (id: string, patch: Record<string, unknown>) => void;
}

function CondView({ node, onRemove, onPatch }: CondProps) {
  const info = operatorInfo(node.op);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Input
        list={FIELD_DATALIST}
        value={node.field}
        onChange={(e) => onPatch(node.id, { field: e.target.value })}
        placeholder="字段"
        className="h-7 w-40 min-w-28 shrink-0 font-mono text-xs"
      />
      <Select
        value={node.op}
        onValueChange={(v) =>
          onPatch(node.id, {
            op: v,
            // 切到 exists 时要有个明确的 true/false，否则预览和界面对不上
            ...(v === "$exists" ? { value: node.value === "false" ? "false" : "true" } : {}),
          })
        }
      >
        <SelectTrigger className="h-7 w-40 shrink-0 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MONGO_OPERATORS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {info.input === "bool" ? (
        <Select value={node.value || "true"} onValueChange={(v) => onPatch(node.id, { value: v })}>
          <SelectTrigger className="h-7 min-w-0 flex-1 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">存在（true）</SelectItem>
            <SelectItem value="false">不存在（false）</SelectItem>
          </SelectContent>
        </Select>
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
