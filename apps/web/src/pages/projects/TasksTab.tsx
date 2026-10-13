import { TodoList } from "../../components/TodoList.tsx";
import type { ProjectView } from "../../types.ts";

/** The signed-in person's own to-dos for the project. */
export function TasksTab({ project }: { project: ProjectView }) {
  return (
    <div className="max-w-3xl">
      <p className="mb-4 text-sm text-muted">
        What you must do yourself for this project: what the Studio asked of you, what came from your mail, and what you write down here. These are yours alone;
        the development plan in the package lists the open ones.
      </p>
      <TodoList projectId={project.id} />
    </div>
  );
}
