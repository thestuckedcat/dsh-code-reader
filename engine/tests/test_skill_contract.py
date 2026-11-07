"""CL-007-A mechanical contract test for the ``learn-code-workspace`` skill.

This suite reads ``skills/learn-code-workspace/SKILL.md`` plus its reference
files and checks the *documented* contract from
``docs/implementation-contract.md`` §10 and the user's 行为守则 rules
(ordinary Q&A answers directly, full retrospective only on an explicit
"学完了/复盘", predictions are never authored by the agent, at most one Next
Action, K2/K3 may stop, evidence grading, no automatic 05 memory writes, no
automatic target build/test execution).

Scope limit: this suite proves only that the required rules are *written down
in a mechanically checkable form*. It does NOT prove learning quality, that a
model follows the skill in a real dialogue, or that ordinary questions never
turn into a quiz. An independent dialogue review is still required for
CL-007-A; a green run here is not evidence of learning effectiveness.

Run from ``engine/``:
    python -m unittest discover -s tests -p "test_skill_contract.py" -v
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

# tests/ -> engine/ -> 04-code-learning/
REPO_ROOT = Path(__file__).resolve().parents[2]
SKILL_DIR = REPO_ROOT / "skills" / "learn-code-workspace"
SKILL_MD = SKILL_DIR / "SKILL.md"
WORKFLOW_MD = SKILL_DIR / "references" / "workflow.md"
LIMITS_MD = SKILL_DIR / "references" / "evidence-and-limits.md"

# Tool surface fixed by docs/implementation-contract.md §10 (six tools, prefix code_).
TOOL_ACTIONS = {
    "code_workspace": ("import", "validate", "status"),
    "code_overview": (),
    "code_source": ("find", "read", "evidence"),
    "code_snapshot": ("import", "status"),
    "code_path": ("path", "relation"),
    "code_learn": ("save", "get", "resume", "export"),
}

# Full retrospective stages, in the order fixed by the user's 行为守则.
RETRO_STAGES = (
    "Knowledge",
    "Level",
    "Nature",
    "Mental Model",
    "Prediction",
    "Experiment",
    "Observation",
    "Difference",
    "Rules",
    "Question",
    "Decision",
)

# Path state machine fixed by docs/software-design.md §8.
PATH_STATES = (
    "scoped",
    "mapped",
    "reading",
    "explanation_ready",
    "prediction_pending",
    "verification_pending",
    "reflected",
    "paused",
    "done",
)

CJK_RE = re.compile(r"[\u4e00-\u9fff]")
FRONTMATTER_KEY_RE = re.compile(r"^([A-Za-z][\w-]*):\s*(.*)$")
# Negations that may legitimately precede a prohibition (Chinese).
NEGATORS = "不勿禁绝毋莫未无须"

# Affirmative phrasings that would authorize automatic behaviour if written
# without a negation.  The skill may *prohibit* these, never instruct them.
AUTO_AFFIRMATIVE_PATTERNS = (
    re.compile(r"自动(?:运行|执行|跑|构建|编译|测试|安装|下载)"),
    re.compile(r"自动(?:.{0,12})?(?:写入|写|保存|同步)"),
    re.compile(r"默认(?:运行|执行|写入|保存)"),
)


def read_required(path: Path) -> str:
    """Return a required skill file as LF-normalized UTF-8 text."""
    if not path.is_file():
        raise AssertionError(f"缺少必需的 skill 文件：{path}")
    return path.read_text(encoding="utf-8").replace("\r\n", "\n")


def parse_frontmatter(text: str):
    """Parse the DSH skill frontmatter the same way the Host provider does.

    The Host-side parser is line based (``^([A-Za-z][\\w-]*):\\s*(.*)$`` over
    trimmed lines), so the test uses the same shape to avoid declaring a file
    valid that the Host would not load.
    """
    if not text.startswith("---\n"):
        raise AssertionError("SKILL.md 必须以 YAML frontmatter（首行 '---'）开头")
    end = text.find("\n---\n", 4)
    if end == -1:
        raise AssertionError("SKILL.md 的 YAML frontmatter 没有结束标记 '---'")
    block = text[4:end]
    body = text[end + len("\n---\n"):]
    metadata = {}
    for line in block.split("\n"):
        match = FRONTMATTER_KEY_RE.match(line.strip())
        if not match:
            continue
        value = match.group(2).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        metadata[match.group(1)] = value
    return metadata, body, block


def find_section(body: str, keyword: str) -> str:
    """Return the ``## ...keyword...`` section of a markdown body."""
    lines = body.split("\n")
    start = None
    for index, line in enumerate(lines):
        if line.startswith("## ") and keyword in line:
            start = index
            break
    if start is None:
        raise AssertionError(f"SKILL.md 缺少标题含 {keyword!r} 的二级章节")
    end = len(lines)
    for index in range(start + 1, len(lines)):
        if lines[index].startswith("## "):
            end = index
            break
    return "\n".join(lines[start:end])


def assert_ordered(case: unittest.TestCase, text: str, tokens, context: str) -> None:
    """Assert every token occurs after the previous one."""
    cursor = -1
    for token in tokens:
        position = text.find(token, cursor + 1)
        if position < 0:
            case.fail(f"{context}：缺少 {token!r} 或出现顺序不符合流程")
        cursor = position


def assert_no_unnegated(case: unittest.TestCase, text: str, patterns, window: int = 40) -> None:
    """Fail when an automatic-behaviour phrase appears without a nearby negation."""
    for pattern in patterns:
        for match in pattern.finditer(text):
            before = text[max(0, match.start() - window):match.start()]
            if not any(negator in before for negator in NEGATORS):
                start = max(0, match.start() - 40)
                end = min(len(text), match.end() + 40)
                case.fail(
                    "出现未加禁止语气的自动行为表述（可能被误读为授权自动执行）："
                    f"{text[start:end]!r}"
                )


class LearnCodeWorkspaceSkillContractTest(unittest.TestCase):
    """Mechanical CL-007-A checks; independent dialogue review still required."""

    # -- files and frontmatter ------------------------------------------------

    def test_01_required_files_exist(self):
        for path in (SKILL_MD, WORKFLOW_MD, LIMITS_MD):
            self.assertTrue(path.is_file(), f"缺少必需文件：{path}")

    def test_02_frontmatter_matches_host_parser(self):
        text = read_required(SKILL_MD)
        metadata, _body, block = parse_frontmatter(text)

        self.assertEqual(metadata.get("name"), "learn-code-workspace")

        description = metadata.get("description", "")
        self.assertTrue(description, "frontmatter description 不能为空")
        self.assertGreaterEqual(len(description), 10, "description 过短，无法用于发现")
        self.assertLessEqual(len(description), 1024, "description 超过通用 1024 字符上限")
        self.assertNotIn(description, (">", "|"), "description 必须是单行普通标量")
        description_lines = [line for line in block.split("\n") if line.strip().startswith("description:")]
        self.assertEqual(len(description_lines), 1, "description 必须恰好一行")

        when_to_use = metadata.get("whenToUse", "")
        self.assertTrue(when_to_use, "frontmatter 缺少 whenToUse")
        self.assertNotIn(when_to_use, (">", "|"), "whenToUse 必须是单行普通标量")
        when_lines = [line for line in block.split("\n") if line.strip().startswith("whenToUse:")]
        self.assertEqual(len(when_lines), 1, "whenToUse 必须恰好一行")

    def test_03_body_is_chinese_and_substantive(self):
        _metadata, body, _block = parse_frontmatter(read_required(SKILL_MD))
        self.assertGreaterEqual(len(CJK_RE.findall(body)), 800, "正文应为内容充分的中文说明")
        self.assertGreater(len(body), 2000, "正文过短，无法覆盖工具与规则")
        self.assertLess(len(body), 30000, "正文过长，模型面向的 skill 应保持精简")

    # -- tool surface ---------------------------------------------------------

    def test_04_six_tools_with_actions(self):
        _metadata, body, _block = parse_frontmatter(read_required(SKILL_MD))
        lowered = body.lower()
        for tool, actions in TOOL_ACTIONS.items():
            self.assertIn(tool, lowered, f"缺少工具名 {tool}")
            tool_lines = [line for line in lowered.split("\n") if tool in line]
            joined = "\n".join(tool_lines)
            for action in actions:
                self.assertIn(action, joined, f"{tool} 缺少 action {action!r} 的说明")
        # Typical arguments should be visible for the main operations.
        for argument in ("workspace", "variant", "repo", "snapshot", "record"):
            self.assertIn(argument, lowered, f"缺少典型参数名 {argument!r}")

    # -- workspace-first flow -------------------------------------------------

    def test_05_workspace_first_flow_order(self):
        _metadata, body, _block = parse_frontmatter(read_required(SKILL_MD))
        flow = find_section(body, "工作流")
        for tool in ("code_workspace", "code_overview", "code_path", "code_source", "code_learn"):
            self.assertIn(tool, flow, f"标准工作流应说明何时使用 {tool}")
        assert_ordered(
            self,
            flow,
            ("登记", "概览", "问题", "证据", "解释", "预测", "核验", "未知", "记录"),
            "标准工作流",
        )

    # -- ordinary questions vs explicit retrospective -------------------------

    def test_06_ordinary_question_answered_directly(self):
        _metadata, body, _block = parse_frontmatter(read_required(SKILL_MD))
        self.assertRegex(body, r"普通(?:代码)?(?:问题|问答|提问).{0,12}直接(?:回答|解答)")
        self.assertRegex(
            body,
            r"(?:不|无需|不必|不要).{0,12}(?:强制|要求|必须).{0,20}(?:完整)?(?:记录|复盘|测验|考试|模板)",
            "应说明普通问答不强制完整记录/考试",
        )

    def test_07_full_retrospective_only_on_explicit_trigger(self):
        _metadata, body, _block = parse_frontmatter(read_required(SKILL_MD))
        self.assertIn("学完了", body)
        self.assertIn("复盘", body)
        self.assertRegex(body, r"(?:只有|仅当|仅在|仅).{0,30}(?:学完了|复盘)", "应把完整复盘限定在用户明确表态时")
        self.assertRegex(body, r"用户.{0,6}明确.{0,8}(?:学完了|复盘)")

        trigger = body.find("学完了")
        window = body[max(0, trigger - 100): trigger + 900]
        assert_ordered(self, window, RETRO_STAGES, "完整复盘的 Knowledge→Decision 流程")
        self.assertIn("pending", window, "复盘流程应说明未完成字段保持 pending")

    # -- pending fields and no fabricated user claims -------------------------

    def test_08_pending_fields_and_no_fabrication(self):
        _metadata, body, _block = parse_frontmatter(read_required(SKILL_MD))
        self.assertIn("pending", body)
        self.assertRegex(body, r"保持.{0,8}pending|pending.{0,8}保持", "应说明未完成字段保持 pending")

        claim_matches = list(re.finditer(r"(?:代填|代写|填写预测|填写观察|替用户(?:写|填))", body))
        self.assertTrue(claim_matches, "应明确禁止替用户填写预测/观察")
        for match in claim_matches:
            before = body[max(0, match.start() - 40):match.start()]
            self.assertTrue(
                any(negator in before for negator in NEGATORS),
                f"出现未加禁止语气的用户主张表述：{body[max(0, match.start() - 40): match.end() + 40]!r}",
            )
        self.assertRegex(body, r"observed.{0,60}evidence", "应说明没有证据的观察不能写成 observed")

    # -- next action and stop rules -------------------------------------------

    def test_09_single_next_action_with_minutes_and_criterion(self):
        _metadata, body, _block = parse_frontmatter(read_required(SKILL_MD))
        self.assertIn("Next Action", body)
        self.assertRegex(body, r"(?:至多|最多|只给|仅给|只能).{0,8}(?:一条|1 ?条|一个)", "Next Action 应至多一条")
        for field in ("动作", "预计用时", "完成标准"):
            self.assertIn(field, body, f"Next Action 缺少字段 {field}")
        self.assertRegex(body, r"预计用时.{0,10}(?:分钟|min)", "预计用时应以分钟计")

        stop = find_section(body, "下一步")
        self.assertIn("Next Action", stop)
        self.assertIn("K2", stop)
        self.assertIn("K3", stop)

    def test_10_k2_k3_may_stop_without_g_q(self):
        _metadata, body, _block = parse_frontmatter(read_required(SKILL_MD))
        self.assertRegex(body, r"K2.{0,10}K3")
        self.assertRegex(body, r"G/Q|G、Q|G 或 Q|G与Q|G和Q", "应出现 G/Q 缺口条件")
        self.assertRegex(body, r"(?:可直接停|可以直接停|可以停|允许停|即可停|停止)", "应说明 K2/K3 可以停止")

    # -- evidence grading and hard boundaries ---------------------------------

    def test_11_evidence_grading_and_no_upgrade(self):
        _metadata, body, _block = parse_frontmatter(read_required(SKILL_MD))
        for token in ("exact", "may", "unknown", "source_text"):
            self.assertIn(token, body.lower(), f"缺少证据等级 {token!r}")
        self.assertRegex(body, r"source[_-]only", "应区分 source-only 读取模式")
        self.assertIn("semantic_status", body)
        self.assertIn("blocked", body.lower())
        for token in ("编译器", "候选", "未知", "文本证据"):
            self.assertIn(token, body, f"缺少证据分级说明 {token!r}")
        self.assertRegex(
            body,
            r"(?:不得|不能|禁止|绝不).{0,20}(?:升级|提升|当作|冒充).{0,20}(?:exact|编译器|事实)",
            "应禁止把文本/人工证据升级为编译器事实",
        )
        self.assertRegex(body, r"may.{0,20}(?:候选|candidate)", "may 应说明为候选")

    def test_12_runtime_hardware_thread_layout_boundary(self):
        _metadata, body, _block = parse_frontmatter(read_required(SKILL_MD))
        for token in ("运行时", "硬件", "线程重叠", "字节布局", "ABI", "ref_only"):
            self.assertIn(token, body, f"缺少边界说明 {token!r}")
        boundary_lines = [line for line in body.split("\n") if "线程重叠" in line]
        self.assertTrue(boundary_lines, "应出现线程重叠的边界说明")
        combined = [
            line for line in boundary_lines
            if all(token in line for token in ("ABI", "字节布局", "硬件", "运行时"))
            and any(negator in line for negator in NEGATORS)
        ]
        self.assertTrue(
            combined,
            "应有把线程重叠/硬件/运行时/布局与目标 ABI 条件写在一起且带否定语气的边界句",
        )

    def test_13_secrets_and_ref_only(self):
        _metadata, body, _block = parse_frontmatter(read_required(SKILL_MD))
        ref_lines = [line for line in body.split("\n") if "ref_only" in line]
        self.assertTrue(ref_lines, "应说明 ref_only 的处理")
        self.assertTrue(any("秘密" in line for line in ref_lines))
        self.assertTrue(any(any(negator in line for negator in NEGATORS) for line in ref_lines))

    # -- resume / invalidation ------------------------------------------------

    def test_14_resume_after_source_change(self):
        _metadata, body, _block = parse_frontmatter(read_required(SKILL_MD))
        resume_lines = [
            line for line in body.split("\n")
            if "resume" in line and ("变化" in line or "改动" in line or "变更" in line)
        ]
        self.assertTrue(resume_lines, "应说明源码/配置变化后先 resume")
        line = resume_lines[0]
        self.assertIn("先", line)
        self.assertTrue("重核" in line or "复核" in line, "变化后应先重核证据")

    # -- explicit prohibitions (negative checks) ------------------------------

    def test_15_no_auto_run_build_or_auto_write_05(self):
        _metadata, body, _block = parse_frontmatter(read_required(SKILL_MD))
        assert_no_unnegated(self, body, AUTO_AFFIRMATIVE_PATTERNS)

        self.assertRegex(
            body,
            r"(?:不|不要|不得|禁止|绝不).{0,20}(?:自动|默认).{0,20}(?:运行|执行|跑).{0,20}"
            r"(?:构建|测试|build|test)",
            "应明确不自动运行目标仓库的构建/测试",
        )
        self.assertRegex(
            body,
            r"(?:不|不要|不得|禁止|绝不).{0,20}(?:自动|默认).{0,20}(?:写|写入|保存|同步).{0,20}"
            r"(?:05|长期记忆)",
            "应明确不自动写 capability 05 长期记忆",
        )

    def test_16_export_only_on_request(self):
        _metadata, body, _block = parse_frontmatter(read_required(SKILL_MD))
        self.assertIn("markdown", body.lower())
        self.assertIn("json", body.lower())
        self.assertRegex(
            body,
            r"(?:仅|只).{0,12}(?:用户|明确|请求|要求).{0,16}(?:导出|export)",
            "应说明仅在用户要求时导出",
        )

    # -- reference files ------------------------------------------------------

    def test_17_workflow_state_machine_and_stop_rules(self):
        workflow = read_required(WORKFLOW_MD)
        assert_ordered(self, workflow, PATH_STATES, "workflow.md 路径状态机")
        for clause in ("停止规则", "证据优先级", "续读"):
            self.assertIn(clause, workflow, f"workflow.md 缺少 {clause!r} 章节")
        for token in ("exact", "may", "unknown", "source_text", "resume", "stale"):
            self.assertIn(token, workflow.lower(), f"workflow.md 缺少 {token!r}")
        self.assertRegex(workflow, r"普通问答.{0,16}(?:结束|停止)", "workflow.md 应说明普通问答可在解释后结束")

    def test_18_workflow_synthetic_ioctl_fixture(self):
        workflow = read_required(WORKFLOW_MD)
        for token in ("job_submit", "JOB_IOCTL_SUBMIT", "job_dispatch", "queue_work", "job_complete"):
            self.assertIn(token, workflow, f"合成示例缺少 {token}")
        self.assertIn("synthetic", workflow.lower())
        self.assertRegex(workflow, r"不是真实.{0,12}证明", "合成示例必须声明不是真实驱动证明")

    def test_19_limits_reference(self):
        limits = read_required(LIMITS_MD)
        lowered = limits.lower()
        for token in ("exact", "may", "unknown", "source_text", "ABI", "ref_only", "semantic_status"):
            self.assertIn(token.lower(), lowered, f"evidence-and-limits.md 缺少 {token!r}")
        self.assertRegex(limits, r"不是.{0,8}运行时|不证明.{0,8}运行时", "限制说明应声明不能证明运行时行为")


if __name__ == "__main__":
    unittest.main()
