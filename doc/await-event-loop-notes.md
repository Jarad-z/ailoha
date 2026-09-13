# `await` 与事件循环

## 核心结论

`await inner()` 不会延迟 `inner()` 的调用。JavaScript 会先计算 `await` 后面的表达式，因此 `inner()` 会立即开始执行。

`await` 暂停的是当前 async 函数中位于它后面的代码。即使等待的是普通值或已经完成的 Promise，后续代码也要通过微任务恢复执行。

可以把：

```ts
const value = await inner();
```

近似理解为：

```ts
const promise = inner(); // 立即调用，执行 inner 的同步部分
// 当前 async 函数在这里暂停
const value = await promise;
```

## 示例

```ts
async function inner() {
	console.log("inner");
	return 42;
}

async function outer() {
	console.log("A");

	queueMicrotask(() => {
		console.log("microtask");
	});

	const value = await inner();

	console.log("B", value);
}

outer();
console.log("C");
```

输出顺序：

```text
A
inner
C
microtask
B 42
```

执行过程：

1. 调用 `outer()`，输出 `A`。
2. `queueMicrotask()` 注册一个微任务，但此时不执行。
3. 为了计算 `await inner()`，立即调用 `inner()`。
4. `inner()` 输出 `inner`，然后返回一个状态为 fulfilled、值为 `42` 的 Promise。
5. `outer()` 在 `await` 处暂停。
6. 当前同步调用栈继续执行，输出 `C`。
7. 同步调用栈清空后，执行已经注册的微任务，输出 `microtask`。
8. 恢复 `outer()`，把 `42` 赋给 `value`，输出 `B 42`。

## 为什么不是 `A → C → inner`

因为 `inner()` 是 `await` 表达式的一部分，必须先执行它，JavaScript 才知道需要等待什么。

`await inner()` 的含义不是“稍后调用 `inner`”，而是“现在调用 `inner`，然后等待它的返回值”。

如果需要把 `inner()` 的调用本身也推迟到微任务中，可以写：

```ts
const value = await Promise.resolve().then(() => inner());
```

此时示例的输出顺序是：

```text
A
C
microtask
inner
B 42
```

## 与 Agent 队列竞态的关系

下面的代码存在竞态：

```ts
if (steerQueue.size === 0) {
	await something();
	run.admission = "closed";
	return;
}
```

可能发生：

```text
检查队列为空
→ 遇到 await，当前函数暂停
→ 其他代码调用 steer()，消息成功入队
→ 当前函数恢复并关闭准入
→ 函数直接返回，没有再次检查队列
```

因此，被接受的 steer 可能没有被处理。

更准确的设计规则是：

> 最终队列检查与关闭消息准入之间不能出现 `await`。最好把“关闭准入、检查队列、决定继续或结束”保持为一个短小的同步过程。

## 异步边界与消息准入状态

核心设计规则是：

> 在跨过异步边界之前，必须同步设置好 active run 的消息准入状态。

异步边界不只包括代码中显式出现的 `await`。当一个 async 函数执行 `return` 时，它返回的 Promise 会完成，等待它的外层函数也要通过微任务恢复。因此，async 函数返回同样是需要考虑的边界。

消息准入状态可以定义为：

```ts
type RunPhase = "react" | "follow_up" | "closing";
```

对应规则：

```text
react       → 接受 steer，也接受 follow-up
follow_up   → 拒绝 steer，接受 follow-up
closing     → 拒绝 steer，也拒绝 follow-up
```

### ReAct 执行期间

等待 LLM、tool 或 compact 时，仍然需要接收 steer 和 follow-up，因此保持 `react`：

```ts
run.phase = "react";
const assistant = await modelRunner.run(context, { signal });
```

不能简单地在每个 `await` 前关闭准入。是否关闭取决于跨过边界后还应不应该接收相应消息。

### 内层循环返回前

内层 ReAct 已经收敛、准备把控制权交给外层 follow-up 循环时，必须先切换阶段：

```ts
run.phase = "follow_up";
return;
```

这样，在 `runReactLoop()` 的 Promise 完成到外层函数恢复之间：

```text
steer     → 拒绝
follow-up → 接受
```

晚到的 steer 不会被接受后遗留在无人处理的队列中，而这段时间进入的 follow-up 仍可由外层循环消费。

### 外层循环返回前

外层循环确认 follow-up 队列为空、准备结束整个 run 时，必须先关闭全部消息准入：

```ts
if (followUps.length === 0) {
	run.phase = "closing";
	return createRunResult(context);
}
```

这样，在 `runAgentLoop()` 的 Promise 完成到外层生命周期代码进入 `finally` 之间，新消息会明确失败，不会出现“消息被接受，但循环已经结束”的情况。

### 最终不变量

```text
任何可能让其他代码插入执行的边界发生前，
active run 必须已经处于明确且正确的消息准入阶段。
```

也就是：

```text
先更新状态
→ 再执行 await 或从 async 函数返回
```

不能依赖更外层的 `finally` 在稍后补充状态，因为在 Promise 完成和 `finally` 恢复之间，其他微任务可能已经尝试提交消息。
