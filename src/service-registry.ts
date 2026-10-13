export type ServiceDisposer = () => void

export class ServiceRegistry {
    private readonly services = new Map<string,unknown>

    provide<T>(name:string,service:T): ServiceDisposer{
        // 1. 检查 name 是否已经存在
        if(this.services.has(name)){
            throw new Error(`service "${name}" is already registered`)
        }
        // 2. 写入 Map
        this.services.set(name,service)
        // 3. 返回 disposer
        // 当前service有没有被销毁
        let disposed = false

        return () => {
            //保证disposer幂等
            if(disposed){
                return
            }
            disposed = true
            this.services.delete(name)
        }
    }

    get<T>(name:string):T{
        // 1. 检查 service 是否存在
        if(!this.services.has(name)){
            throw new Error(`service "${name}" is not registered`)
        }
        // 2. 返回 service
        return this.services.get(name) as T
    }

    has(name:string):boolean{
        return this.services.has(name)
    }

}
