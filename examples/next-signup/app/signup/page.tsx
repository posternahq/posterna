export default function SignUp() {
  return (
    <main>
      <h1>Sign up</h1>
      <form method="post" action="/api/signup">
        <input name="email" type="email" required />
        <button type="submit">Sign up</button>
      </form>
    </main>
  );
}
